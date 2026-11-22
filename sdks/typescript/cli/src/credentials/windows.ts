import { runProcess } from './process';
import { SERVICE, storeUnavailable, type CredentialStore } from './store';

/**
 * Windows Credential Manager (generic credentials, persisted per user on this
 * machine) through advapi32 CredWrite/CredRead/CredDelete, called from
 * PowerShell. The operation and target travel in environment variables and the
 * secret on stdin, so nothing sensitive is in argv, and the script is passed with
 * -EncodedCommand so no quoting is involved.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AnlyonCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  private const int GENERIC = 1;
  private const int NOT_FOUND = 1168;
  public static void Write(string target, string user, string secret) {
    byte[] bytes = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = GENERIC; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = bytes.Length; c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return null;
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(p); }
  }
  public static bool Delete(string target) {
    if (CredDeleteW(target, GENERIC, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == NOT_FOUND) return false;
    throw new System.ComponentModel.Win32Exception(e);
  }
}
'@
$target = $env:ANLYON_CRED_TARGET
switch ($env:ANLYON_CRED_OP) {
  'write' { [AnlyonCred]::Write($target, $env:ANLYON_CRED_USER, [Console]::In.ReadToEnd()); 'OK' }
  'read' { $v = [AnlyonCred]::Read($target); if ($v -eq $null) { 'NOTFOUND' } else { 'FOUND:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) } }
  'delete' { if ([AnlyonCred]::Delete($target)) { 'DELETED' } else { 'NOTFOUND' } }
}
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

export class WindowsCredentialStore implements CredentialStore {
  readonly name = 'windows-credential-manager';
  readonly secure = true;
  readonly maxSecretBytes = 2560;

  private async run(op: 'read' | 'write' | 'delete', account: string, input?: string): Promise<string> {
    const result = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      {
        input,
        env: { ...process.env, ANLYON_CRED_OP: op, ANLYON_CRED_TARGET: `${SERVICE}:${account}`, ANLYON_CRED_USER: account },
        timeoutMs: 60_000,
      },
    );
    if (result.spawnError) throw storeUnavailable(this.name, result.spawnError.message);
    if (result.code !== 0) throw storeUnavailable(this.name, result.stderr.trim().split('\n')[0] || `powershell exited ${result.code}`);
    return result.stdout.trim();
  }

  async get(account: string): Promise<string | null> {
    const out = await this.run('read', account);
    if (out === 'NOTFOUND') return null;
    if (!out.startsWith('FOUND:')) throw storeUnavailable(this.name, 'unexpected helper output');
    return Buffer.from(out.slice('FOUND:'.length), 'base64').toString('utf8');
  }

  async set(account: string, secret: string): Promise<void> {
    if (Buffer.byteLength(secret, 'utf8') > this.maxSecretBytes) {
      throw storeUnavailable(this.name, `secret exceeds ${this.maxSecretBytes} bytes`);
    }
    const out = await this.run('write', account, secret);
    if (out !== 'OK') throw storeUnavailable(this.name, 'unexpected helper output');
  }

  async delete(account: string): Promise<boolean> {
    return (await this.run('delete', account)) === 'DELETED';
  }
}
