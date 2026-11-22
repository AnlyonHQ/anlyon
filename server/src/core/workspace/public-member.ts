interface MemberWithUserRow {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  emergencyAccess: boolean;
  invitedBy: string | null;
  invitedAt: Date | null;
  joinedAt: Date;
  createdAt: Date;
  userName: string;
  userEmail: string;
}

export function toPublicWorkspaceMember(member: MemberWithUserRow) {
  return {
    id: member.id,
    workspaceId: member.workspaceId,
    userId: member.userId,
    role: member.role,
    emergencyAccess: member.emergencyAccess,
    invitedBy: member.invitedBy,
    invitedAt: member.invitedAt,
    joinedAt: member.joinedAt,
    createdAt: member.createdAt,
    user: {
      name: member.userName,
      email: member.userEmail,
    },
  };
}
