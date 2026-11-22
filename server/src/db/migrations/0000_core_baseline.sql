CREATE TYPE public.action_invocation_status AS ENUM (
    'pending_approval',
    'running',
    'succeeded',
    'failed',
    'unknown',
    'denied',
    'expired'
);
--> statement-breakpoint
CREATE TYPE public.action_method AS ENUM (
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE'
);
--> statement-breakpoint
CREATE TYPE public.approval_advice_recommendation AS ENUM (
    'approve',
    'deny',
    'review'
);
--> statement-breakpoint
CREATE TYPE public.approval_advice_status AS ENUM (
    'pending',
    'ready',
    'failed',
    'skipped'
);
--> statement-breakpoint
CREATE TYPE public.approval_decision AS ENUM (
    'approve',
    'deny'
);
--> statement-breakpoint
CREATE TYPE public.approval_decision_origin AS ENUM (
    'human',
    'policy',
    'system',
    'unknown',
    'assistant'
);
--> statement-breakpoint
CREATE TYPE public.approval_kind AS ENUM (
    'action',
    'custom',
    'function_plan'
);
--> statement-breakpoint
CREATE TYPE public.approval_policy_effect AS ENUM (
    'require_approval',
    'auto_approve',
    'auto_deny'
);
--> statement-breakpoint
CREATE TYPE public.approval_policy_match_kind AS ENUM (
    'any',
    'action',
    'custom'
);
--> statement-breakpoint
CREATE TYPE public.approval_status AS ENUM (
    'pending',
    'approved',
    'denied',
    'expired'
);
--> statement-breakpoint
CREATE TYPE public.effect_outcome AS ENUM (
    'not_dispatched',
    'pending',
    'succeeded',
    'failed',
    'unknown'
);
--> statement-breakpoint
CREATE TYPE public.effect_stage AS ENUM (
    'awaiting_approval',
    'ready',
    'dispatching',
    'reconciling',
    'settled',
    'rejected'
);
--> statement-breakpoint
CREATE TYPE public.environment_kind AS ENUM (
    'development',
    'staging',
    'production'
);
--> statement-breakpoint
CREATE TYPE public.event_status AS ENUM (
    'received',
    'fanned_out',
    'no_subscribers'
);
--> statement-breakpoint
CREATE TYPE public.http_method AS ENUM (
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE'
);
--> statement-breakpoint
CREATE TYPE public.integration_type AS ENUM (
    'slack',
    'discord'
);
--> statement-breakpoint
CREATE TYPE public.invitation_status AS ENUM (
    'pending',
    'accepted',
    'declined',
    'expired',
    'cancelled'
);
--> statement-breakpoint
CREATE TYPE public.message_status AS ENUM (
    'pending',
    'scheduled',
    'processing',
    'delivered',
    'failed',
    'cancelled'
);
--> statement-breakpoint
CREATE TYPE public.notification_channel AS ENUM (
    'email',
    'webhook',
    'in_app',
    'slack',
    'discord'
);
--> statement-breakpoint
CREATE TYPE public.notification_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);
--> statement-breakpoint
CREATE TYPE public.notification_type AS ENUM (
    'quota_warning',
    'quota_exceeded',
    'payment_failed',
    'plan_upgraded',
    'plan_downgraded',
    'feature_enabled',
    'system_alert',
    'security_alert',
    'delivery_failure_spike',
    'api_key_expiring',
    'approval_requested',
    'budget_alert',
    'approval_expired',
    'outcome_unknown',
    'connection_broken'
);
--> statement-breakpoint
CREATE TYPE public.plan AS ENUM (
    'free',
    'paygo',
    'enterprise',
    'production',
    'growth',
    'starter'
);
--> statement-breakpoint
CREATE TYPE public.queue_status AS ENUM (
    'active',
    'paused',
    'deleted'
);
--> statement-breakpoint
CREATE TYPE public.role AS ENUM (
    'owner',
    'admin',
    'member',
    'approver',
    'viewer'
);
--> statement-breakpoint
CREATE TYPE public.run_feedback_source AS ENUM (
    'user',
    'model',
    'code'
);
--> statement-breakpoint
CREATE TYPE public.run_status AS ENUM (
    'running',
    'succeeded',
    'failed',
    'cancelled'
);
--> statement-breakpoint
CREATE TYPE public.span_status AS ENUM (
    'running',
    'succeeded',
    'failed'
);
--> statement-breakpoint
CREATE TYPE public.span_type AS ENUM (
    'model_call',
    'context_assembly',
    'session_read',
    'session_write',
    'memory_recall',
    'memory_write',
    'tool_call',
    'action_call',
    'approval_wait',
    'approval_decision',
    'workflow_step',
    'queue_delivery',
    'event_delivery',
    'custom',
    'budget_check'
);
--> statement-breakpoint
CREATE FUNCTION public.anlyon_capture_policy_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  record_snapshot jsonb;
  provenance jsonb := coalesce(nullif(current_setting('anlyon.policy_actor', true), ''), '{}')::jsonb;
  operation_name text;
  version_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Do not create orphan evidence during explicit tenant/environment deletion.
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) OR
       NOT EXISTS (SELECT 1 FROM environments WHERE id = OLD.environment_id) THEN RETURN OLD; END IF;
    record_snapshot := to_jsonb(OLD);
    version_number := OLD.version + 1;
    record_snapshot := jsonb_set(record_snapshot, '{version}', to_jsonb(version_number));
    operation_name := 'deleted';
  ELSE
    record_snapshot := to_jsonb(NEW);
    version_number := NEW.version;
    operation_name := CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END;
  END IF;
  INSERT INTO approval_policy_versions
    (workspace_id, environment_id, policy_id, version, operation, snapshot, content_hash, actor_type, actor_id, change_note)
  VALUES ((record_snapshot->>'workspace_id')::uuid, (record_snapshot->>'environment_id')::uuid,
    record_snapshot->>'policy_id', version_number, operation_name, record_snapshot,
    encode(sha256(convert_to(record_snapshot::text, 'UTF8')), 'hex'),
    CASE WHEN provenance->>'type' IN ('api_key', 'user') AND nullif(provenance->>'id', '') IS NOT NULL
      THEN provenance->>'type' ELSE 'unknown' END,
    CASE WHEN provenance->>'type' IN ('api_key', 'user') THEN nullif(provenance->>'id', '') ELSE NULL END,
    provenance->>'note');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.anlyon_guard_action_effect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
    OR NEW.action_id IS DISTINCT FROM OLD.action_id
    OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
    OR NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.action_name IS DISTINCT FROM OLD.action_name
    OR NEW.action_version_id IS DISTINCT FROM OLD.action_version_id
    OR NEW.adapter_type IS DISTINCT FROM OLD.adapter_type
    OR NEW.adapter_version IS DISTINCT FROM OLD.adapter_version
    OR NEW.requested_by_key_id IS DISTINCT FROM OLD.requested_by_key_id
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.target_account IS DISTINCT FROM OLD.target_account
    OR NEW.resource_key IS DISTINCT FROM OLD.resource_key
    OR NEW.target IS DISTINCT FROM OLD.target
    OR NEW.request IS DISTINCT FROM OLD.request
    OR NEW.impact IS DISTINCT FROM OLD.impact
    OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
    OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key
    OR NEW.depends_on IS DISTINCT FROM OLD.depends_on
    OR NEW.compensates_effect_id IS DISTINCT FROM OLD.compensates_effect_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'An effect''s request and identity are immutable';
  END IF;
  IF (OLD.preview_id IS NOT NULL AND NEW.preview_id IS DISTINCT FROM OLD.preview_id)
    OR (OLD.binding_digest IS NOT NULL AND NEW.binding_digest IS DISTINCT FROM OLD.binding_digest)
    OR (OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id)
    OR (OLD.approval_consumed_at IS NOT NULL AND NEW.approval_consumed_at IS DISTINCT FROM OLD.approval_consumed_at) THEN
    RAISE EXCEPTION 'An effect''s binding can be set once';
  END IF;
  IF OLD.outcome IN ('succeeded', 'failed') THEN
    IF NEW.outcome <> OLD.outcome OR NEW.outcome_source IS DISTINCT FROM OLD.outcome_source
      OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
      RAISE EXCEPTION 'A confirmed effect outcome is never rewritten';
    END IF;
    IF NEW.partial_effect <> OLD.partial_effect AND OLD.partial_effect <> 'possible' THEN
      RAISE EXCEPTION 'Only a possible partial effect can be resolved';
    END IF;
  END IF;
  IF OLD.outcome <> 'not_dispatched' AND NEW.outcome = 'not_dispatched' THEN
    RAISE EXCEPTION 'A dispatched effect cannot return to not_dispatched';
  END IF;
  IF OLD.stage IN ('settled', 'rejected') AND NEW.stage <> OLD.stage THEN
    RAISE EXCEPTION 'A settled or rejected effect is terminal';
  END IF;
  IF OLD.outcome_verified AND NOT NEW.outcome_verified THEN
    RAISE EXCEPTION 'A verified effect outcome is never unverified';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.anlyon_policy_version_before_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.policy_id <> OLD.policy_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.environment_id <> OLD.environment_id THEN
    RAISE EXCEPTION 'Policy identity and scope are immutable';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.anlyon_protect_effect_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) OR
    NOT EXISTS (SELECT 1 FROM environments WHERE id = OLD.environment_id) OR
    NOT EXISTS (SELECT 1 FROM action_effects WHERE id = OLD.effect_id)
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Effect evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.anlyon_protect_invocation_resolution() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) OR
    NOT EXISTS (SELECT 1 FROM environments WHERE id = OLD.environment_id) OR
    NOT EXISTS (SELECT 1 FROM action_invocations WHERE id = OLD.invocation_id)
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Invocation resolutions are append-only';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.anlyon_protect_policy_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Explicit removal of the owning tenant/environment also removes its retained history.
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) OR
      NOT EXISTS (SELECT 1 FROM environments WHERE id = OLD.environment_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Policy history is append-only';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.audit_events_guard_removal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF coalesce(current_setting('anlyon.audit_removal', true), '') IN ('archive', 'retention') THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_events rows are removed only by the audit lifecycle (archive or retention)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.audit_events_refuse_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.end_user_id IS DISTINCT FROM OLD.end_user_id
    AND OLD.end_user_id IS NOT NULL
    AND NEW.end_user_id LIKE 'erased~%'
    AND (
      NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
      OR (OLD.resource_type = 'end_user' AND OLD.resource_id = OLD.end_user_id AND NEW.resource_id = NEW.end_user_id)
    )
    AND (to_jsonb(NEW) - 'end_user_id' - 'resource_id') = (to_jsonb(OLD) - 'end_user_id' - 'resource_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TABLE public.account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp without time zone,
    refresh_token_expires_at timestamp without time zone,
    scope text,
    password text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.action_effects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    action_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    effect_id text NOT NULL,
    operation_key text NOT NULL,
    request_digest text NOT NULL,
    action_name text NOT NULL,
    action_version_id text NOT NULL,
    adapter_type text NOT NULL,
    adapter_version text NOT NULL,
    requested_by_key_id uuid,
    requested_by_user_id text,
    target_account text NOT NULL,
    resource_key text NOT NULL,
    target jsonb NOT NULL,
    request jsonb NOT NULL,
    impact jsonb NOT NULL,
    capabilities jsonb NOT NULL,
    provider_idempotency_key text,
    preview_id uuid,
    binding_digest text,
    approval_id text,
    approval_consumed_at timestamp with time zone,
    depends_on jsonb DEFAULT '[]'::jsonb NOT NULL,
    compensates_effect_id text,
    stage public.effect_stage NOT NULL,
    outcome public.effect_outcome DEFAULT 'not_dispatched'::public.effect_outcome NOT NULL,
    partial_effect text DEFAULT 'none'::text NOT NULL,
    outcome_source text,
    provider_reference text,
    rejection_reason text,
    first_dispatched_at timestamp with time zone,
    outcome_at timestamp with time zone,
    next_reconcile_at timestamp with time zone,
    reconcile_attempts integer DEFAULT 0 NOT NULL,
    reconcile_lease_owner text,
    reconcile_lease_until timestamp with time zone,
    reconcile_exhausted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome_verified boolean DEFAULT false NOT NULL,
    grade text GENERATED ALWAYS AS (
CASE
    WHEN (stage = 'rejected'::public.effect_stage) THEN
    CASE
        WHEN (rejection_reason = 'approval_denied'::text) THEN 'denied'::text
        ELSE 'refused'::text
    END
    WHEN (outcome = 'succeeded'::public.effect_outcome) THEN
    CASE
        WHEN (outcome_verified AND (outcome_source = 'provider'::text)) THEN 'confirmed'::text
        ELSE 'acknowledged'::text
    END
    WHEN (outcome = 'failed'::public.effect_outcome) THEN 'failed'::text
    WHEN (outcome = 'unknown'::public.effect_outcome) THEN 'unknown'::text
    ELSE 'pending'::text
END) STORED NOT NULL,
    end_user_id text,
    CONSTRAINT action_effects_outcome_source_check CHECK (((outcome_source IS NULL) OR (outcome_source = ANY (ARRAY['provider'::text, 'manual'::text, 'system'::text])))),
    CONSTRAINT action_effects_outcome_verified_check CHECK (((NOT outcome_verified) OR ((outcome = 'succeeded'::public.effect_outcome) AND (outcome_source = 'provider'::text)))),
    CONSTRAINT action_effects_partial_effect_check CHECK ((partial_effect = ANY (ARRAY['none'::text, 'possible'::text, 'confirmed'::text]))),
    CONSTRAINT action_effects_stage_outcome_check CHECK ((((stage <> 'rejected'::public.effect_stage) OR (outcome = 'not_dispatched'::public.effect_outcome)) AND ((stage <> 'settled'::public.effect_stage) OR (outcome = ANY (ARRAY['succeeded'::public.effect_outcome, 'failed'::public.effect_outcome]))) AND ((stage <> ALL (ARRAY['awaiting_approval'::public.effect_stage, 'ready'::public.effect_stage])) OR (outcome = 'not_dispatched'::public.effect_outcome))))
);
--> statement-breakpoint
CREATE TABLE public.action_invocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    action_id uuid NOT NULL,
    invocation_id text NOT NULL,
    status public.action_invocation_status DEFAULT 'running'::public.action_invocation_status NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_status integer,
    response_body text,
    error_message text,
    approval_id text,
    requested_by_key_id uuid,
    duration_ms integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    trace_run_id text,
    trace_parent_span_id text,
    environment_id uuid NOT NULL,
    definition_snapshot jsonb,
    action_version_id text,
    budget_reservation_id uuid,
    usage_month text,
    usage_state text,
    dispatch_claimed_at timestamp with time zone,
    decision jsonb,
    idempotency_key text,
    idempotency_fingerprint text,
    retry_of_invocation_id text,
    effect_id text,
    end_user_id text
);
--> statement-breakpoint
CREATE TABLE public.action_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    action_id uuid NOT NULL,
    action_version_id text NOT NULL,
    version integer NOT NULL,
    method public.action_method NOT NULL,
    url_template text NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    body_template jsonb,
    input_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    adapter jsonb,
    declarations jsonb,
    mcp jsonb
);
--> statement-breakpoint
CREATE TABLE public.actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    action_id text NOT NULL,
    name text NOT NULL,
    description text,
    method public.action_method DEFAULT 'POST'::public.action_method NOT NULL,
    url_template text NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    body_template jsonb,
    input_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    environment_id uuid NOT NULL,
    current_version_id text,
    archived_at timestamp without time zone,
    adapter jsonb,
    declarations jsonb,
    mcp jsonb
);
--> statement-breakpoint
CREATE TABLE public.agent_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    agent_version_id text NOT NULL,
    version integer NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    agent_id text NOT NULL,
    name text NOT NULL,
    description text,
    current_version_id uuid,
    archived_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.alert_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    alert_type text NOT NULL,
    alert_key text NOT NULL,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.api_key_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    api_key_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    previous_key_hash_encrypted text NOT NULL,
    previous_key_prefix text NOT NULL,
    version integer NOT NULL,
    rotated_at timestamp without time zone DEFAULT now() NOT NULL,
    rollback_expires_at timestamp without time zone NOT NULL,
    rotated_by text
);
--> statement-breakpoint
CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    is_active text DEFAULT 'true'::text,
    last_used_at timestamp without time zone,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone,
    version integer DEFAULT 1 NOT NULL,
    scopes jsonb,
    environment_id uuid NOT NULL,
    budget_principal text,
    end_user_required boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.approval_advice (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    approval_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    status public.approval_advice_status DEFAULT 'pending'::public.approval_advice_status NOT NULL,
    status_reason text,
    model text,
    recommendation public.approval_advice_recommendation,
    risk real,
    confidence real,
    flags jsonb,
    reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    history jsonb,
    input_tokens integer,
    latency_ms integer,
    attempts integer DEFAULT 0 NOT NULL,
    claimed_at timestamp without time zone,
    audit_requested boolean DEFAULT false NOT NULL,
    audit_verdict text,
    audited_by_user_id text,
    audited_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.approval_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    approval_id uuid NOT NULL,
    decider_key_id uuid,
    decider_user_id text,
    decision public.approval_decision NOT NULL,
    note text,
    decided_at timestamp without time zone DEFAULT now() NOT NULL,
    self_approved boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.approval_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    policy_id text NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    match_kind public.approval_policy_match_kind DEFAULT 'any'::public.approval_policy_match_kind NOT NULL,
    match_action_name text,
    match_agent_id text,
    match_user_id text,
    match_tags jsonb,
    min_amount numeric,
    conditions jsonb,
    effect public.approval_policy_effect DEFAULT 'require_approval'::public.approval_policy_effect NOT NULL,
    required_approvals integer DEFAULT 1 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    scope_reviewed_at timestamp without time zone,
    condition text,
    managed_by_file text,
    managed_key text,
    decided_by text DEFAULT 'team'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.approval_policy_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    policy_id text NOT NULL,
    version integer NOT NULL,
    operation text NOT NULL,
    snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    change_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    approval_id text NOT NULL,
    kind public.approval_kind DEFAULT 'custom'::public.approval_kind NOT NULL,
    status public.approval_status DEFAULT 'pending'::public.approval_status NOT NULL,
    title text NOT NULL,
    description text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_by_key_id uuid,
    decided_by_user_id text,
    decided_by_key_id uuid,
    decision_note text,
    expires_at timestamp without time zone NOT NULL,
    decided_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    required_approvals integer DEFAULT 1 NOT NULL,
    approved_count integer DEFAULT 0 NOT NULL,
    matched_policy_id text,
    matched_policy_version integer,
    policy_explanation text,
    trace_run_id text,
    trace_parent_span_id text,
    trace_started_at timestamp without time zone,
    environment_id uuid NOT NULL,
    decision_origin public.approval_decision_origin,
    preview_id text,
    binding_digest text,
    requested_by_user_id text,
    requested_by_oauth_client_id text,
    end_user_id text,
    decided_by text DEFAULT 'team'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.archival_tracking (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partition_name text NOT NULL,
    log_type text NOT NULL,
    partition_date timestamp without time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    total_records integer,
    archived_records integer DEFAULT 0,
    r2_manifest_keys jsonb,
    archival_started_at timestamp without time zone,
    archival_completed_at timestamp without time zone,
    partition_dropped_at timestamp without time zone,
    last_error text,
    retry_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.assistant_usage (
    workspace_id uuid NOT NULL,
    period text NOT NULL,
    kind text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.audit_archives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid,
    day text NOT NULL,
    object_key text NOT NULL,
    manifest_key text NOT NULL,
    record_count integer NOT NULL,
    first_seq bigint NOT NULL,
    last_seq bigint NOT NULL,
    first_occurred_at timestamp with time zone NOT NULL,
    last_occurred_at timestamp with time zone NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    content_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expired_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.audit_events (
    seq bigint NOT NULL,
    tx_id bigint DEFAULT ((pg_current_xact_id())::text)::bigint NOT NULL,
    event_id text NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid,
    type text NOT NULL,
    category text NOT NULL,
    outcome text,
    actor_type text NOT NULL,
    actor_id text,
    resource_type text,
    resource_id text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    backfilled boolean DEFAULT false NOT NULL,
    context jsonb,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    end_user_id text
);
--> statement-breakpoint
CREATE SEQUENCE public.audit_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE public.audit_events_seq_seq OWNED BY public.audit_events.seq;
--> statement-breakpoint
CREATE TABLE public.audit_lifecycle (
    workspace_id uuid NOT NULL,
    contract_retention_months integer,
    contract_set_by text,
    plan_retention_months integer,
    floor_months integer,
    floor_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.audit_settings (
    workspace_id uuid NOT NULL,
    retention_days integer,
    allow_private_destinations boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.audit_sink_dead_letters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    sink_id uuid NOT NULL,
    from_tx_id bigint NOT NULL,
    from_seq bigint NOT NULL,
    to_tx_id bigint NOT NULL,
    to_seq bigint NOT NULL,
    event_count integer NOT NULL,
    first_event_id text NOT NULL,
    last_event_id text NOT NULL,
    attempts integer NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_retry_at timestamp with time zone,
    redelivered_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.audit_sinks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sink_id text NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    credentials_encrypted text NOT NULL,
    credentials_hint text,
    enabled boolean DEFAULT true NOT NULL,
    event_types text[] DEFAULT '{*}'::text[] NOT NULL,
    environment_ids uuid[],
    include_history boolean DEFAULT false NOT NULL,
    cursor_tx_id bigint NOT NULL,
    cursor_seq bigint NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_error text,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    delivered_count bigint DEFAULT 0 NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.budget_periods (
    api_key_id uuid NOT NULL,
    month text NOT NULL,
    messages bigint DEFAULT 0 NOT NULL,
    event_publishes bigint DEFAULT 0 NOT NULL,
    action_invokes bigint DEFAULT 0 NOT NULL,
    cost_microcents bigint DEFAULT 0 NOT NULL,
    reconciliation_required boolean DEFAULT false NOT NULL,
    reconciliation_note text,
    reconciled_at timestamp with time zone,
    CONSTRAINT budget_period_nonnegative CHECK (((messages >= 0) AND (event_publishes >= 0) AND (action_invokes >= 0) AND (cost_microcents >= 0)))
);
--> statement-breakpoint
CREATE TABLE public.budget_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    api_key_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    effect_id text NOT NULL,
    fingerprint text NOT NULL,
    dimension text NOT NULL,
    amount bigint NOT NULL,
    month text NOT NULL,
    cost_microcents bigint NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT budget_reservation_dimension CHECK ((dimension = ANY (ARRAY['messages'::text, 'eventPublishes'::text, 'cacheLookups'::text, 'memoryOps'::text, 'actionInvokes'::text]))),
    CONSTRAINT budget_reservation_quantity CHECK (((amount >= 0) AND (cost_microcents >= 0))),
    CONSTRAINT budget_reservation_state CHECK ((state = ANY (ARRAY['reserved'::text, 'settled'::text, 'refunded'::text])))
);
--> statement-breakpoint
CREATE TABLE public.delivery_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    secret_encrypted text NOT NULL,
    secret_prefix text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_active text DEFAULT 'true'::text,
    last_used_at timestamp without time zone,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.effect_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    effect_id uuid NOT NULL,
    attempt_no integer NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'started'::text NOT NULL,
    lease_owner text NOT NULL,
    lease_until timestamp with time zone NOT NULL,
    observed_outcome text,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT effect_attempts_kind_check CHECK ((kind = ANY (ARRAY['dispatch'::text, 'replay'::text, 'reconcile'::text]))),
    CONSTRAINT effect_attempts_status_check CHECK ((status = ANY (ARRAY['started'::text, 'completed'::text, 'abandoned'::text])))
);
--> statement-breakpoint
CREATE TABLE public.effect_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    effect_id uuid NOT NULL,
    attempt_id uuid,
    source text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    implied_outcome text,
    provider_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_type text DEFAULT 'system'::text NOT NULL,
    actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT effect_evidence_source_check CHECK ((source = ANY (ARRAY['provider_response'::text, 'provider_lookup'::text, 'system'::text, 'operator_note'::text, 'manual_resolution'::text, 'preview'::text])))
);
--> statement-breakpoint
CREATE TABLE public.effect_previews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    action_id uuid NOT NULL,
    preview_id text NOT NULL,
    action_name text NOT NULL,
    action_version_id text NOT NULL,
    adapter_type text NOT NULL,
    adapter_version text NOT NULL,
    request_digest text NOT NULL,
    binding_digest text NOT NULL,
    target_account text NOT NULL,
    resource_key text NOT NULL,
    target jsonb NOT NULL,
    request jsonb NOT NULL,
    input jsonb NOT NULL,
    impact jsonb NOT NULL,
    evidence jsonb NOT NULL,
    blocks jsonb NOT NULL,
    preconditions jsonb NOT NULL,
    capabilities jsonb NOT NULL,
    allowances jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence_observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    supersedes_preview_id text,
    requested_by_key_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    end_user_id text
);
--> statement-breakpoint
CREATE TABLE public.end_user_erasures (
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    erased_as text NOT NULL,
    erased_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.environment_oauth_apps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    integration_key text NOT NULL,
    client_id text NOT NULL,
    client_secret_encrypted text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.environments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_protected boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    halted_at timestamp without time zone,
    halted_reason text,
    halted_by text,
    kind public.environment_kind DEFAULT 'production'::public.environment_kind NOT NULL,
    allowed_redirect_urls text[] DEFAULT '{}'::text[] NOT NULL,
    default_redirect_url text,
    connect_confirmation text DEFAULT 'required'::text NOT NULL,
    CONSTRAINT environments_connect_confirmation_check CHECK ((connect_confirmation = ANY (ARRAY['required'::text, 'off'::text])))
);
--> statement-breakpoint
CREATE TABLE public.event_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    topic_id uuid NOT NULL,
    subscription_id text NOT NULL,
    url text NOT NULL,
    event_types text[] DEFAULT '{*}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    secret_encrypted text,
    headers jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    environment_id uuid NOT NULL,
    delivery_format text DEFAULT 'anlyon'::text NOT NULL,
    expires_at timestamp without time zone,
    mcp_event_name text,
    mcp_principal text,
    mcp_environment_id uuid
);
--> statement-breakpoint
CREATE TABLE public.event_topics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    topic_id text NOT NULL,
    name text NOT NULL,
    description text,
    is_reserved boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    environment_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    topic_id uuid NOT NULL,
    event_id text NOT NULL,
    type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text,
    status public.event_status DEFAULT 'received'::public.event_status NOT NULL,
    subscription_count integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    trace_run_id text,
    trace_parent_span_id text,
    environment_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.function_run_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    run_row_id uuid NOT NULL,
    sequence integer NOT NULL,
    action_name text NOT NULL,
    canonical_input text NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    invocation_id text,
    refusal_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    planned_sequence integer,
    CONSTRAINT function_run_calls_kind_check CHECK ((kind = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT function_run_calls_state_check CHECK ((state = ANY (ARRAY['intent'::text, 'dispatched'::text, 'refused'::text, 'failed'::text])))
);
--> statement-breakpoint
CREATE TABLE public.function_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    function_row_id uuid NOT NULL,
    function_version_row_id uuid NOT NULL,
    run_id text NOT NULL,
    mode text DEFAULT 'straight_through'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    end_user_id text,
    end_user_required boolean DEFAULT false NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    input_digest text NOT NULL,
    output jsonb,
    error jsonb,
    logs jsonb DEFAULT '[]'::jsonb NOT NULL,
    budget_exceeded text,
    action_call_count integer DEFAULT 0 NOT NULL,
    call_count integer DEFAULT 0 NOT NULL,
    runner_execution_id text,
    plan_digest text,
    approval_id text,
    receipt jsonb,
    requested_by_key_id uuid,
    requested_by_user_id text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    plan jsonb,
    plan_run_row_id uuid,
    applied_by_run_id text,
    write_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT function_runs_mode_check CHECK ((mode = ANY (ARRAY['straight_through'::text, 'plan'::text, 'apply'::text]))),
    CONSTRAINT function_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'budget_exceeded'::text, 'planned'::text, 'awaiting_approval'::text, 'diverged'::text])))
);
--> statement-breakpoint
CREATE TABLE public.function_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    function_row_id uuid NOT NULL,
    version_id text NOT NULL,
    version integer NOT NULL,
    language text NOT NULL,
    source_modules jsonb NOT NULL,
    digest text NOT NULL,
    allowed_actions jsonb NOT NULL,
    input_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    max_action_calls integer NOT NULL,
    max_cpu_ms integer NOT NULL,
    max_subrequests integer NOT NULL,
    timeout_ms integer NOT NULL,
    review jsonb,
    published_by_key_id uuid,
    published_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    straight_through jsonb,
    CONSTRAINT function_versions_budgets_check CHECK (((max_action_calls > 0) AND (max_cpu_ms > 0) AND (max_subrequests > 0) AND (timeout_ms > 0))),
    CONSTRAINT function_versions_language_check CHECK ((language = ANY (ARRAY['javascript'::text, 'python'::text])))
);
--> statement-breakpoint
CREATE TABLE public.functions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    function_id text NOT NULL,
    name text NOT NULL,
    description text,
    current_version_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.impact_limit_periods (
    limit_id uuid NOT NULL,
    period_key text NOT NULL,
    consumed bigint DEFAULT 0 NOT NULL,
    reserved bigint DEFAULT 0 NOT NULL,
    unknown_exposure bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT impact_limit_periods_non_negative CHECK (((consumed >= 0) AND (reserved >= 0) AND (unknown_exposure >= 0) AND (unknown_exposure <= reserved)))
);
--> statement-breakpoint
CREATE TABLE public.impact_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    limit_id text NOT NULL,
    name text NOT NULL,
    dimension text NOT NULL,
    currency text,
    action_name text,
    resource_prefix text,
    period text NOT NULL,
    amount bigint NOT NULL,
    outstanding_reserved bigint DEFAULT 0 NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scope text DEFAULT 'environment'::text NOT NULL,
    CONSTRAINT impact_limits_amount_check CHECK ((amount >= 0)),
    CONSTRAINT impact_limits_currency_check CHECK ((((dimension = 'money'::text) AND (currency ~ '^[a-z]{3}$'::text)) OR ((dimension <> 'money'::text) AND (currency IS NULL)))),
    CONSTRAINT impact_limits_dimension_check CHECK ((dimension ~ '^[a-z][a-z0-9_]{0,31}$'::text)),
    CONSTRAINT impact_limits_outstanding_check CHECK ((outstanding_reserved >= 0)),
    CONSTRAINT impact_limits_period_check CHECK ((period = ANY (ARRAY['day'::text, 'month'::text, 'total'::text]))),
    CONSTRAINT impact_limits_scope_check CHECK ((scope = ANY (ARRAY['environment'::text, 'end_user'::text])))
);
--> statement-breakpoint
CREATE TABLE public.impact_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    effect_id uuid NOT NULL,
    limit_id uuid NOT NULL,
    period_key text NOT NULL,
    dimension text NOT NULL,
    currency text,
    amount bigint NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    exposure text,
    settled_amount bigint DEFAULT 0 NOT NULL,
    released_amount bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT impact_reservations_amounts_check CHECK (((amount >= 0) AND (settled_amount >= 0) AND (released_amount >= 0) AND ((settled_amount + released_amount) <= amount))),
    CONSTRAINT impact_reservations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'settled'::text, 'released'::text])))
);
--> statement-breakpoint
CREATE TABLE public.instance_admins (
    user_id text NOT NULL,
    granted_by text,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.instance_settings (
    key text NOT NULL,
    value text,
    encrypted_value text,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.integration_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    type public.integration_type NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    slack_team_id text,
    slack_team_name text,
    slack_channel_id text,
    slack_channel_name text,
    slack_access_token_encrypted text,
    slack_bot_user_id text,
    discord_webhook_url_encrypted text,
    discord_server_id text,
    discord_channel_name text,
    enabled_event_types jsonb DEFAULT '["quota_warning", "quota_exceeded", "payment_failed", "security_alert"]'::jsonb NOT NULL,
    last_used_at timestamp without time zone,
    last_error text,
    error_count integer DEFAULT 0 NOT NULL,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.invocation_resolutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    outcome text NOT NULL,
    evidence text NOT NULL,
    external_reference text,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.jwks (
    id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone,
    alg text,
    crv text
);
--> statement-breakpoint
CREATE TABLE public.key_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    monthly_cost_cents_cap integer,
    dimension_caps jsonb DEFAULT '{}'::jsonb NOT NULL,
    alert_threshold real DEFAULT 0.8 NOT NULL,
    alerted_at timestamp without time zone,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.mcp_upstreams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upstream_id text NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    registry_name text,
    protocol_version text,
    server_info jsonb,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools_hash text,
    listed_at timestamp without time zone,
    last_error jsonb,
    archived_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    oauth jsonb,
    operator_connection_id text,
    listed_with text,
    checked_at timestamp without time zone,
    next_check_at timestamp without time zone DEFAULT now() NOT NULL,
    check_failures integer DEFAULT 0 NOT NULL,
    tool_changes jsonb,
    transport text,
    end_user_key jsonb
);
--> statement-breakpoint
CREATE TABLE public.member_environment_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id text NOT NULL,
    environment_id uuid NOT NULL,
    role public.role NOT NULL,
    granted_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.message_enqueue_outbox (
    message_id text NOT NULL,
    commands jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.message_quota_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    month text NOT NULL,
    day text NOT NULL,
    count integer NOT NULL,
    bytes bigint NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    CONSTRAINT message_quota_quantity CHECK (((count > 0) AND (bytes >= 0))),
    CONSTRAINT message_quota_state CHECK ((state = ANY (ARRAY['reserved'::text, 'billed'::text, 'released'::text])))
);
--> statement-breakpoint
CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    queue_id uuid,
    message_id text NOT NULL,
    content_hash text,
    url text NOT NULL,
    method public.http_method DEFAULT 'POST'::public.http_method NOT NULL,
    headers jsonb,
    body jsonb,
    scheduled_for timestamp without time zone,
    status public.message_status DEFAULT 'pending'::public.message_status NOT NULL,
    attempts integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    response_status integer,
    response_body text,
    error_message text,
    delivered_at timestamp without time zone,
    failed_at timestamp without time zone,
    callback_url text,
    failure_callback_url text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    event_id uuid,
    event_subscription_id uuid,
    trace_run_id text,
    trace_parent_span_id text,
    trace_started_at timestamp without time zone,
    environment_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notification_delivery_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    notification_id uuid,
    type public.notification_type NOT NULL,
    channel public.notification_channel NOT NULL,
    recipient text NOT NULL,
    status text NOT NULL,
    error_message text,
    retry_count text DEFAULT '0'::text,
    payload jsonb,
    sent_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email_enabled boolean DEFAULT true NOT NULL,
    webhook_enabled boolean DEFAULT false NOT NULL,
    in_app_enabled boolean DEFAULT true NOT NULL,
    slack_enabled boolean DEFAULT false NOT NULL,
    discord_enabled boolean DEFAULT false NOT NULL,
    email_recipients jsonb DEFAULT '[]'::jsonb,
    webhook_url text,
    webhook_secret text,
    quota_alert_thresholds jsonb DEFAULT '[50, 75, 90, 100]'::jsonb,
    enabled_types jsonb DEFAULT '["quota_warning", "quota_exceeded", "payment_failed", "security_alert", "approval_requested", "budget_alert", "approval_expired", "outcome_unknown", "connection_broken"]'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notification_user_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id text NOT NULL,
    muted_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id text,
    type public.notification_type NOT NULL,
    priority public.notification_priority DEFAULT 'medium'::public.notification_priority NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    metadata jsonb,
    action_url text,
    action_label text,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.oauth_access_token (
    id text NOT NULL,
    token text,
    client_id text NOT NULL,
    session_id text,
    user_id text,
    reference_id text,
    refresh_id text,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    scopes text[] NOT NULL,
    authorization_code_id text,
    resources text[],
    requested_user_info_claims text[],
    revoked timestamp without time zone,
    confirmation jsonb
);
--> statement-breakpoint
CREATE TABLE public.oauth_client (
    id text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    disabled boolean DEFAULT false,
    skip_consent boolean DEFAULT false,
    enable_end_session boolean DEFAULT false,
    subject_type text,
    scopes text[],
    user_id text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    name text,
    uri text,
    icon text,
    contacts text[],
    tos text,
    policy text,
    software_id text,
    software_version text,
    software_statement text,
    redirect_uris text[] NOT NULL,
    post_logout_redirect_uris text[],
    token_endpoint_auth_method text,
    grant_types text[],
    response_types text[],
    public boolean,
    type text,
    require_pkce boolean,
    reference_id text,
    metadata jsonb,
    client_discovery_id text,
    client_credentials_scopes text[] DEFAULT '{}'::text[],
    backchannel_logout_uri text,
    backchannel_logout_session_required boolean,
    application_type text,
    jwks text,
    jwks_uri text,
    dpop_bound_access_tokens boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE public.oauth_client_assertion (
    id text NOT NULL,
    expires_at timestamp without time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.oauth_client_resource (
    id text NOT NULL,
    client_id text NOT NULL,
    resource_id text NOT NULL,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.oauth_connections (
    id text NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    integration_key text NOT NULL,
    end_user_id text NOT NULL,
    access_token_encrypted text NOT NULL,
    refresh_token_encrypted text,
    expires_at timestamp with time zone,
    scopes text,
    connection_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    revoked_at timestamp with time zone,
    last_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    refresh_lease_until timestamp with time zone,
    subject_end_user_id text,
    oauth_client_id text,
    pending_confirmation_until timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.oauth_consent (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text,
    reference_id text,
    scopes text[] NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    resources text[],
    requested_user_info_claims text[]
);
--> statement-breakpoint
CREATE TABLE public.oauth_refresh_token (
    id text NOT NULL,
    token text NOT NULL,
    client_id text NOT NULL,
    session_id text,
    user_id text NOT NULL,
    reference_id text,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    revoked timestamp without time zone,
    auth_time timestamp without time zone,
    scopes text[] NOT NULL,
    authorization_code_id text,
    resources text[],
    requested_user_info_claims text[],
    rotated_at timestamp without time zone,
    rotation_replay_response text,
    rotation_replay_expires_at timestamp without time zone,
    confirmation jsonb
);
--> statement-breakpoint
CREATE TABLE public.oauth_resource (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    access_token_ttl integer,
    refresh_token_ttl integer,
    signing_algorithm text,
    signing_key_id text,
    allowed_scopes text[],
    custom_claims jsonb,
    dpop_bound_access_tokens_required boolean DEFAULT false,
    disabled boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    policy_version integer DEFAULT 1,
    metadata jsonb
);
--> statement-breakpoint
CREATE TABLE public.oauth_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id text NOT NULL,
    provider text NOT NULL,
    state text NOT NULL,
    redirect_url text,
    expires_at timestamp without time zone NOT NULL,
    used_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.oauth_workspace_binding (
    id text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.queues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    queue_id text NOT NULL,
    name text NOT NULL,
    description text,
    parallelism integer DEFAULT 1 NOT NULL,
    status public.queue_status DEFAULT 'active'::public.queue_status NOT NULL,
    is_paused boolean DEFAULT false NOT NULL,
    message_count integer DEFAULT 0,
    pending_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    environment_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.rate_limit (
    id text NOT NULL,
    key text,
    count integer,
    last_request bigint
);
--> statement-breakpoint
CREATE TABLE public.run_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    run_id uuid NOT NULL,
    span_id text,
    feedback_id text NOT NULL,
    source public.run_feedback_source DEFAULT 'user'::public.run_feedback_source NOT NULL,
    label text,
    rating numeric,
    comment text,
    metadata jsonb,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    agent_id text,
    agent_version_id text,
    run_id text NOT NULL,
    name text,
    status public.run_status DEFAULT 'running'::public.run_status NOT NULL,
    user_id text,
    application text,
    input jsonb,
    output jsonb,
    error jsonb,
    tokens integer,
    cost numeric,
    tags jsonb,
    metadata jsonb,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    ended_at timestamp without time zone,
    duration_ms integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.secret_store_settings (
    workspace_id uuid NOT NULL,
    allow_private_network boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);
--> statement-breakpoint
CREATE TABLE public.secret_stores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    store_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    config jsonb NOT NULL,
    credential_encrypted text NOT NULL,
    allowed_paths jsonb,
    cache_ttl_seconds integer DEFAULT 30 NOT NULL,
    health jsonb,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.session (
    id text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.sign_off_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sign_off_id text NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    operation text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    target jsonb DEFAULT '{}'::jsonb NOT NULL,
    sealed_input text NOT NULL,
    base_digest text NOT NULL,
    request_digest text NOT NULL,
    classification jsonb NOT NULL,
    summary text NOT NULL,
    resource jsonb,
    requester_scopes jsonb,
    requested_by_type text NOT NULL,
    requested_by_key_id uuid,
    requested_by_oauth_client_id text,
    requested_by_user_id text,
    decided_by_user_id text,
    decided_via text,
    decision_note text,
    result jsonb,
    error jsonb,
    expires_at timestamp without time zone NOT NULL,
    decided_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sign_off_requests_status CHECK ((status = ANY (ARRAY['pending'::text, 'applying'::text, 'applied'::text, 'rejected'::text, 'expired'::text, 'cancelled'::text, 'failed'::text])))
);
--> statement-breakpoint
CREATE TABLE public.slack_approval_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    approval_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_user_id text NOT NULL,
    user_id text,
    identified_by text,
    decision text NOT NULL,
    result text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.slack_approval_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    approval_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    channel_id text NOT NULL,
    message_ts text,
    rendered_digest text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.slack_approval_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    integration_id uuid NOT NULL,
    channel_id text NOT NULL,
    channel_name text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.slack_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_user_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.spans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    run_id uuid NOT NULL,
    span_id text NOT NULL,
    parent_span_id text,
    name text NOT NULL,
    type public.span_type DEFAULT 'custom'::public.span_type NOT NULL,
    status public.span_status DEFAULT 'running'::public.span_status NOT NULL,
    input jsonb,
    output jsonb,
    error jsonb,
    model text,
    provider text,
    tokens jsonb,
    cost numeric,
    attributes jsonb,
    started_at timestamp without time zone NOT NULL,
    ended_at timestamp without time zone,
    duration_ms integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.sso_provider (
    id text NOT NULL,
    issuer text NOT NULL,
    oidc_config text,
    saml_config text,
    user_id text,
    provider_id text NOT NULL,
    organization_id uuid,
    domain text NOT NULL,
    domain_verified boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE public.sso_sessions (
    session_id text NOT NULL,
    provider_id text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.trace_archives (
    r2_key text NOT NULL,
    workspace_id uuid NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public."twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    backup_codes text NOT NULL,
    user_id text NOT NULL,
    verified boolean DEFAULT true NOT NULL,
    failed_verification_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    date text NOT NULL,
    messages_published bigint DEFAULT 0,
    messages_delivered bigint DEFAULT 0,
    messages_failed bigint DEFAULT 0,
    bandwidth_bytes bigint DEFAULT 0,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    event_publishes bigint DEFAULT 0,
    action_invokes bigint DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    two_factor_enabled boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_action_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    units bigint NOT NULL,
    used_units bigint DEFAULT 0 NOT NULL,
    source_order_id text NOT NULL,
    granted_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_action_credits_positive CHECK ((units > 0)),
    CONSTRAINT workspace_action_credits_used_within CHECK (((used_units >= 0) AND (used_units <= units)))
);
--> statement-breakpoint
CREATE TABLE public.workspace_assistant_settings (
    workspace_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    consent_version text,
    consented_by_user_id text,
    consented_at timestamp without time zone,
    excluded_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    auto_approve jsonb DEFAULT '{"actions": [], "enabled": false, "maxRisk": 1, "minHistory": 20, "minConfidence": 0.9}'::jsonb NOT NULL,
    audit_sample_rate real DEFAULT 0.1 NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_budget_periods (
    workspace_id uuid NOT NULL,
    month text NOT NULL,
    projected_overage_cents bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_budgets (
    workspace_id uuid NOT NULL,
    max_overage_cents integer DEFAULT 0 NOT NULL,
    alert_thresholds jsonb DEFAULT '[50, 75, 90, 100]'::jsonb NOT NULL,
    behaviour_at_max text DEFAULT 'alert_only'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT workspace_budget_alert_only CHECK ((behaviour_at_max = 'alert_only'::text)),
    CONSTRAINT workspace_budget_nonnegative CHECK ((max_overage_cents >= 0))
);
--> statement-breakpoint
CREATE TABLE public.workspace_defaults (
    workspace_id uuid NOT NULL,
    acting_for text,
    end_user_decider text,
    approval_window_hours integer,
    setup_status text,
    setup_at timestamp without time zone,
    updated_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_defaults_acting_for CHECK ((acting_for = ANY (ARRAY['team'::text, 'users'::text, 'both'::text]))),
    CONSTRAINT workspace_defaults_approval_window CHECK (((approval_window_hours >= 1) AND (approval_window_hours <= 168))),
    CONSTRAINT workspace_defaults_end_user_decider CHECK ((end_user_decider = ANY (ARRAY['team'::text, 'end_user'::text]))),
    CONSTRAINT workspace_defaults_setup_status CHECK ((setup_status = ANY (ARRAY['completed'::text, 'skipped'::text])))
);
--> statement-breakpoint
CREATE TABLE public.workspace_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    role public.role DEFAULT 'member'::public.role NOT NULL,
    status public.invitation_status DEFAULT 'pending'::public.invitation_status NOT NULL,
    token text NOT NULL,
    invited_by text,
    invited_user_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    accepted_at timestamp without time zone,
    declined_at timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id text NOT NULL,
    role public.role DEFAULT 'member'::public.role NOT NULL,
    invited_by text,
    invited_at timestamp without time zone DEFAULT now(),
    joined_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    emergency_access boolean DEFAULT false NOT NULL,
    CONSTRAINT workspace_members_emergency_access_admin CHECK (((NOT emergency_access) OR (role = 'admin'::public.role))),
    CONSTRAINT workspace_members_no_owner_role CHECK ((role <> 'owner'::public.role))
);
--> statement-breakpoint
CREATE TABLE public.workspace_scim_configs (
    workspace_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    default_role public.role DEFAULT 'member'::public.role NOT NULL,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    rotated_at timestamp without time zone,
    last_used_at timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE public.workspace_scim_group_members (
    group_id uuid NOT NULL,
    scim_user_id uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_scim_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    display_name text NOT NULL,
    external_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_scim_role_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    group_name text NOT NULL,
    role public.role NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_scim_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id text NOT NULL,
    external_id text,
    user_name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    secret_id text NOT NULL,
    name text NOT NULL,
    value_encrypted text NOT NULL,
    description text,
    last_used_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    environment_id uuid NOT NULL,
    allowed_hosts jsonb,
    allowed_placements jsonb,
    kind text DEFAULT 'static'::text NOT NULL,
    connection jsonb,
    integration_id text,
    health jsonb,
    secret_store_id uuid,
    external jsonb
);
--> statement-breakpoint
CREATE TABLE public.workspace_sso_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_id text NOT NULL,
    protocol text NOT NULL,
    domains jsonb NOT NULL,
    domain_verification_token text NOT NULL,
    domains_verified_at timestamp without time zone,
    enforced boolean DEFAULT false NOT NULL,
    default_role public.role DEFAULT 'member'::public.role NOT NULL,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.workspace_usage_periods (
    workspace_id uuid NOT NULL,
    month text NOT NULL,
    action_reserved bigint DEFAULT 0 NOT NULL,
    action_billed bigint DEFAULT 0 NOT NULL,
    messages_reserved bigint DEFAULT 0 NOT NULL,
    messages_billed bigint DEFAULT 0 NOT NULL,
    bandwidth_reserved bigint DEFAULT 0 NOT NULL,
    bandwidth_billed bigint DEFAULT 0 NOT NULL,
    condition_drafts bigint DEFAULT 0 NOT NULL,
    action_credits_drawn bigint DEFAULT 0 NOT NULL,
    function_runs bigint DEFAULT 0 NOT NULL,
    CONSTRAINT workspace_usage_nonnegative CHECK (((action_reserved >= 0) AND (action_billed >= 0)))
);
--> statement-breakpoint
CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    plan public.plan DEFAULT 'free'::public.plan NOT NULL,
    subscription_status text DEFAULT 'active'::text,
    trial_ends_at timestamp without time zone,
    monthly_message_quota text DEFAULT '1000'::text,
    current_month_messages bigint DEFAULT 0,
    current_month_bandwidth bigint DEFAULT 0,
    usage_reset_date timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    delivery_suspended_at timestamp without time zone,
    delivery_suspended_reason text,
    pending_plan public.plan,
    billing_interval text,
    current_period_end timestamp without time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events ALTER COLUMN seq SET DEFAULT nextval('public.audit_events_seq_seq'::regclass);
--> statement-breakpoint
ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_effect_id_unique UNIQUE (effect_id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_scoped_identity UNIQUE (id, workspace_id, environment_id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_invocations
    ADD CONSTRAINT action_invocations_invocation_id_unique UNIQUE (invocation_id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_invocations
    ADD CONSTRAINT action_invocations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_versions
    ADD CONSTRAINT action_versions_action_version_id_unique UNIQUE (action_version_id);
--> statement-breakpoint
ALTER TABLE ONLY public.action_versions
    ADD CONSTRAINT action_versions_action_version_unique UNIQUE (action_id, version);
--> statement-breakpoint
ALTER TABLE ONLY public.action_versions
    ADD CONSTRAINT action_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_action_id_unique UNIQUE (action_id);
--> statement-breakpoint
ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_version_id_unique UNIQUE (agent_version_id);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_version_unique UNIQUE (agent_id, version);
--> statement-breakpoint
ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_agent_id_unique UNIQUE (agent_id);
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_env_name_unique UNIQUE (environment_id, name);
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.alert_history
    ADD CONSTRAINT alert_history_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.api_key_history
    ADD CONSTRAINT api_key_history_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_budget_principal_unique UNIQUE (budget_principal);
--> statement-breakpoint
ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_advice
    ADD CONSTRAINT approval_advice_approval_id_unique UNIQUE (approval_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_advice
    ADD CONSTRAINT approval_advice_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_env_name_unique UNIQUE (environment_id, name);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_policy_id_unique UNIQUE (policy_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policy_versions
    ADD CONSTRAINT approval_policy_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policy_versions
    ADD CONSTRAINT approval_policy_versions_policy_version_unique UNIQUE (policy_id, version);
--> statement-breakpoint
ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_approval_id_unique UNIQUE (approval_id);
--> statement-breakpoint
ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.archival_tracking
    ADD CONSTRAINT archival_tracking_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.assistant_usage
    ADD CONSTRAINT assistant_usage_workspace_id_period_kind_pk PRIMARY KEY (workspace_id, period, kind);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_archives
    ADD CONSTRAINT audit_archives_object_key_unique UNIQUE (object_key);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_archives
    ADD CONSTRAINT audit_archives_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_event_id_unique UNIQUE (event_id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (seq);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_lifecycle
    ADD CONSTRAINT audit_lifecycle_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_settings
    ADD CONSTRAINT audit_settings_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_sink_dead_letters
    ADD CONSTRAINT audit_sink_dead_letters_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_sinks
    ADD CONSTRAINT audit_sinks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.audit_sinks
    ADD CONSTRAINT audit_sinks_sink_id_unique UNIQUE (sink_id);
--> statement-breakpoint
ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_api_key_id_month_pk PRIMARY KEY (api_key_id, month);
--> statement-breakpoint
ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_secrets
    ADD CONSTRAINT delivery_secrets_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.effect_attempts
    ADD CONSTRAINT effect_attempts_effect_attempt_unique UNIQUE (effect_id, attempt_no);
--> statement-breakpoint
ALTER TABLE ONLY public.effect_attempts
    ADD CONSTRAINT effect_attempts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.effect_evidence
    ADD CONSTRAINT effect_evidence_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.effect_previews
    ADD CONSTRAINT effect_previews_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.effect_previews
    ADD CONSTRAINT effect_previews_preview_id_unique UNIQUE (preview_id);
--> statement-breakpoint
ALTER TABLE ONLY public.end_user_erasures
    ADD CONSTRAINT end_user_erasures_environment_id_erased_as_pk PRIMARY KEY (environment_id, erased_as);
--> statement-breakpoint
ALTER TABLE ONLY public.environment_oauth_apps
    ADD CONSTRAINT environment_oauth_apps_env_integration_unique UNIQUE (environment_id, integration_key);
--> statement-breakpoint
ALTER TABLE ONLY public.environment_oauth_apps
    ADD CONSTRAINT environment_oauth_apps_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_workspace_slug_unique UNIQUE (workspace_id, slug);
--> statement-breakpoint
ALTER TABLE ONLY public.event_subscriptions
    ADD CONSTRAINT event_subscriptions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.event_subscriptions
    ADD CONSTRAINT event_subscriptions_subscription_id_unique UNIQUE (subscription_id);
--> statement-breakpoint
ALTER TABLE ONLY public.event_topics
    ADD CONSTRAINT event_topics_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.event_topics
    ADD CONSTRAINT event_topics_topic_id_unique UNIQUE (topic_id);
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_event_id_unique UNIQUE (event_id);
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.function_run_calls
    ADD CONSTRAINT function_run_calls_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_run_id_unique UNIQUE (run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.function_versions
    ADD CONSTRAINT function_versions_function_version_unique UNIQUE (function_row_id, version);
--> statement-breakpoint
ALTER TABLE ONLY public.function_versions
    ADD CONSTRAINT function_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.function_versions
    ADD CONSTRAINT function_versions_version_id_unique UNIQUE (version_id);
--> statement-breakpoint
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_function_id_unique UNIQUE (function_id);
--> statement-breakpoint
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.impact_limit_periods
    ADD CONSTRAINT impact_limit_periods_pk PRIMARY KEY (limit_id, period_key);
--> statement-breakpoint
ALTER TABLE ONLY public.impact_limits
    ADD CONSTRAINT impact_limits_limit_id_unique UNIQUE (limit_id);
--> statement-breakpoint
ALTER TABLE ONLY public.impact_limits
    ADD CONSTRAINT impact_limits_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.impact_reservations
    ADD CONSTRAINT impact_reservations_effect_limit_unique UNIQUE (effect_id, limit_id);
--> statement-breakpoint
ALTER TABLE ONLY public.impact_reservations
    ADD CONSTRAINT impact_reservations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.instance_admins
    ADD CONSTRAINT instance_admins_pkey PRIMARY KEY (user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.instance_settings
    ADD CONSTRAINT instance_settings_pkey PRIMARY KEY (key);
--> statement-breakpoint
ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.invocation_resolutions
    ADD CONSTRAINT invocation_resolutions_invocation_unique UNIQUE (invocation_id);
--> statement-breakpoint
ALTER TABLE ONLY public.invocation_resolutions
    ADD CONSTRAINT invocation_resolutions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.key_budgets
    ADD CONSTRAINT key_budgets_api_key_id_unique UNIQUE (api_key_id);
--> statement-breakpoint
ALTER TABLE ONLY public.key_budgets
    ADD CONSTRAINT key_budgets_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_upstreams
    ADD CONSTRAINT mcp_upstreams_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_upstreams
    ADD CONSTRAINT mcp_upstreams_upstream_id_unique UNIQUE (upstream_id);
--> statement-breakpoint
ALTER TABLE ONLY public.member_environment_roles
    ADD CONSTRAINT member_environment_roles_member_env_unique UNIQUE (workspace_id, user_id, environment_id);
--> statement-breakpoint
ALTER TABLE ONLY public.member_environment_roles
    ADD CONSTRAINT member_environment_roles_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.message_enqueue_outbox
    ADD CONSTRAINT message_enqueue_outbox_pkey PRIMARY KEY (message_id);
--> statement-breakpoint
ALTER TABLE ONLY public.message_quota_reservations
    ADD CONSTRAINT message_quota_reservations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_message_id_unique UNIQUE (message_id);
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notification_delivery_log
    ADD CONSTRAINT notification_delivery_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_workspace_id_unique UNIQUE (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.notification_user_preferences
    ADD CONSTRAINT notification_user_preferences_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client_assertion
    ADD CONSTRAINT oauth_client_assertion_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client
    ADD CONSTRAINT oauth_client_client_id_unique UNIQUE (client_id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client
    ADD CONSTRAINT oauth_client_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client_resource
    ADD CONSTRAINT oauth_client_resource_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_connections
    ADD CONSTRAINT oauth_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_resource
    ADD CONSTRAINT oauth_resource_identifier_unique UNIQUE (identifier);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_resource
    ADD CONSTRAINT oauth_resource_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_state_unique UNIQUE (state);
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_workspace_binding
    ADD CONSTRAINT oauth_workspace_binding_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.queues
    ADD CONSTRAINT queues_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.queues
    ADD CONSTRAINT queues_queue_id_unique UNIQUE (queue_id);
--> statement-breakpoint
ALTER TABLE ONLY public.rate_limit
    ADD CONSTRAINT rate_limit_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_feedback
    ADD CONSTRAINT run_feedback_feedback_id_unique UNIQUE (feedback_id);
--> statement-breakpoint
ALTER TABLE ONLY public.run_feedback
    ADD CONSTRAINT run_feedback_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_run_id_unique UNIQUE (run_id);
--> statement-breakpoint
ALTER TABLE ONLY public.secret_store_settings
    ADD CONSTRAINT secret_store_settings_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.secret_stores
    ADD CONSTRAINT secret_stores_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.secret_stores
    ADD CONSTRAINT secret_stores_store_id_unique UNIQUE (store_id);
--> statement-breakpoint
ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.sign_off_requests
    ADD CONSTRAINT sign_off_requests_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.sign_off_requests
    ADD CONSTRAINT sign_off_requests_sign_off_id_unique UNIQUE (sign_off_id);
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_actions
    ADD CONSTRAINT slack_approval_actions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_messages
    ADD CONSTRAINT slack_approval_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_routes
    ADD CONSTRAINT slack_approval_routes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.slack_user_links
    ADD CONSTRAINT slack_user_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.spans
    ADD CONSTRAINT spans_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.spans
    ADD CONSTRAINT spans_run_span_unique UNIQUE (run_id, span_id);
--> statement-breakpoint
ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_provider_id_unique UNIQUE (provider_id);
--> statement-breakpoint
ALTER TABLE ONLY public.sso_sessions
    ADD CONSTRAINT sso_sessions_pkey PRIMARY KEY (session_id);
--> statement-breakpoint
ALTER TABLE ONLY public.trace_archives
    ADD CONSTRAINT trace_archives_pkey PRIMARY KEY (r2_key);
--> statement-breakpoint
ALTER TABLE ONLY public."twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.usage_logs
    ADD CONSTRAINT usage_logs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);
--> statement-breakpoint
ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_action_credits
    ADD CONSTRAINT workspace_action_credits_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_action_credits
    ADD CONSTRAINT workspace_action_credits_source_order_id_unique UNIQUE (source_order_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_assistant_settings
    ADD CONSTRAINT workspace_assistant_settings_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_budget_periods
    ADD CONSTRAINT workspace_budget_periods_workspace_id_month_pk PRIMARY KEY (workspace_id, month);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_budgets
    ADD CONSTRAINT workspace_budgets_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_defaults
    ADD CONSTRAINT workspace_defaults_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_email_pending UNIQUE (workspace_id, email);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_user_unique UNIQUE (workspace_id, user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_configs
    ADD CONSTRAINT workspace_scim_configs_pkey PRIMARY KEY (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_configs
    ADD CONSTRAINT workspace_scim_configs_token_hash_unique UNIQUE (token_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_group_members
    ADD CONSTRAINT workspace_scim_group_members_group_id_scim_user_id_pk PRIMARY KEY (group_id, scim_user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_groups
    ADD CONSTRAINT workspace_scim_groups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_role_mappings
    ADD CONSTRAINT workspace_scim_role_mappings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_users
    ADD CONSTRAINT workspace_scim_users_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_secret_id_unique UNIQUE (secret_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_sso_connections
    ADD CONSTRAINT workspace_sso_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_sso_connections
    ADD CONSTRAINT workspace_sso_connections_provider_id_unique UNIQUE (provider_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_sso_connections
    ADD CONSTRAINT workspace_sso_connections_workspace_id_unique UNIQUE (workspace_id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_usage_periods
    ADD CONSTRAINT workspace_usage_periods_workspace_id_month_pk PRIMARY KEY (workspace_id, month);
--> statement-breakpoint
ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_unique UNIQUE (slug);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON public.account USING btree (user_id);
--> statement-breakpoint
CREATE INDEX action_effects_env_end_user_idx ON public.action_effects USING btree (environment_id, end_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX action_effects_invocation_unique ON public.action_effects USING btree (invocation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX action_effects_operation_unique ON public.action_effects USING btree (workspace_id, environment_id, operation_key);
--> statement-breakpoint
CREATE UNIQUE INDEX action_effects_preview_unique ON public.action_effects USING btree (preview_id) WHERE (preview_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX action_effects_reconcile_due_idx ON public.action_effects USING btree (next_reconcile_at) WHERE (next_reconcile_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX action_effects_stage_idx ON public.action_effects USING btree (stage);
--> statement-breakpoint
CREATE INDEX action_effects_ws_created_idx ON public.action_effects USING btree (workspace_id, environment_id, created_at);
--> statement-breakpoint
CREATE INDEX action_invocations_action_id_idx ON public.action_invocations USING btree (action_id);
--> statement-breakpoint
CREATE INDEX action_invocations_approval_id_idx ON public.action_invocations USING btree (approval_id);
--> statement-breakpoint
CREATE INDEX action_invocations_env_end_user_idx ON public.action_invocations USING btree (environment_id, end_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX action_invocations_idempotency_unique ON public.action_invocations USING btree (workspace_id, environment_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
--> statement-breakpoint
CREATE INDEX action_invocations_invocation_id_idx ON public.action_invocations USING btree (invocation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX action_invocations_retry_of_unique ON public.action_invocations USING btree (retry_of_invocation_id) WHERE (retry_of_invocation_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX action_invocations_trace_run_id_idx ON public.action_invocations USING btree (trace_run_id);
--> statement-breakpoint
CREATE INDEX action_invocations_ws_created_idx ON public.action_invocations USING btree (workspace_id, environment_id, created_at);
--> statement-breakpoint
CREATE INDEX actions_action_id_idx ON public.actions USING btree (action_id);
--> statement-breakpoint
CREATE UNIQUE INDEX actions_ws_name_unique ON public.actions USING btree (workspace_id, environment_id, name) WHERE (archived_at IS NULL);
--> statement-breakpoint
CREATE INDEX approval_advice_status_created_idx ON public.approval_advice USING btree (status, created_at);
--> statement-breakpoint
CREATE INDEX approval_advice_ws_created_idx ON public.approval_advice USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX approval_decisions_approval_idx ON public.approval_decisions USING btree (approval_id);
--> statement-breakpoint
CREATE UNIQUE INDEX approval_decisions_assistant_unique ON public.approval_decisions USING btree (approval_id) WHERE ((decider_key_id IS NULL) AND (decider_user_id IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX approval_decisions_key_unique ON public.approval_decisions USING btree (approval_id, decider_key_id) WHERE (decider_key_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX approval_decisions_user_unique ON public.approval_decisions USING btree (approval_id, decider_user_id) WHERE (decider_user_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX approval_policies_env_priority_idx ON public.approval_policies USING btree (environment_id, priority);
--> statement-breakpoint
CREATE UNIQUE INDEX approval_policies_managed_key_unique ON public.approval_policies USING btree (environment_id, managed_by_file, managed_key) WHERE (managed_by_file IS NOT NULL);
--> statement-breakpoint
CREATE INDEX approval_policy_versions_scope_idx ON public.approval_policy_versions USING btree (workspace_id, environment_id, policy_id);
--> statement-breakpoint
CREATE INDEX approvals_approval_id_idx ON public.approvals USING btree (approval_id);
--> statement-breakpoint
CREATE INDEX approvals_env_end_user_idx ON public.approvals USING btree (environment_id, end_user_id);
--> statement-breakpoint
CREATE INDEX approvals_status_expires_idx ON public.approvals USING btree (status, expires_at);
--> statement-breakpoint
CREATE INDEX approvals_trace_run_id_idx ON public.approvals USING btree (trace_run_id);
--> statement-breakpoint
CREATE INDEX approvals_ws_origin_idx ON public.approvals USING btree (workspace_id, environment_id, decision_origin, created_at);
--> statement-breakpoint
CREATE INDEX approvals_ws_status_idx ON public.approvals USING btree (workspace_id, environment_id, status);
--> statement-breakpoint
CREATE INDEX audit_archives_ws_range_idx ON public.audit_archives USING btree (workspace_id, last_occurred_at);
--> statement-breakpoint
CREATE INDEX audit_events_delivery_idx ON public.audit_events USING btree (workspace_id, tx_id, seq);
--> statement-breakpoint
CREATE INDEX audit_events_env_end_user_idx ON public.audit_events USING btree (environment_id, end_user_id);
--> statement-breakpoint
CREATE INDEX audit_events_ws_occurred_idx ON public.audit_events USING btree (workspace_id, occurred_at);
--> statement-breakpoint
CREATE INDEX audit_events_ws_seq_idx ON public.audit_events USING btree (workspace_id, seq DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX audit_sink_dead_letters_sink_idx ON public.audit_sink_dead_letters USING btree (sink_id, created_at);
--> statement-breakpoint
CREATE INDEX audit_sinks_due_idx ON public.audit_sinks USING btree (enabled, next_attempt_at);
--> statement-breakpoint
CREATE INDEX audit_sinks_ws_idx ON public.audit_sinks USING btree (workspace_id);
--> statement-breakpoint
CREATE UNIQUE INDEX budget_effect_active_idx ON public.budget_reservations USING btree (api_key_id, effect_id, dimension) WHERE (state <> 'refunded'::text);
--> statement-breakpoint
CREATE INDEX budget_effect_history_idx ON public.budget_reservations USING btree (api_key_id, effect_id, dimension, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_secrets_one_active_per_workspace ON public.delivery_secrets USING btree (workspace_id) WHERE (is_active = 'true'::text);
--> statement-breakpoint
CREATE INDEX delivery_secrets_workspace_active_idx ON public.delivery_secrets USING btree (workspace_id, is_active);
--> statement-breakpoint
CREATE UNIQUE INDEX effect_attempts_one_dispatch ON public.effect_attempts USING btree (effect_id) WHERE (kind = 'dispatch'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX effect_attempts_one_write_in_flight ON public.effect_attempts USING btree (effect_id) WHERE ((status = 'started'::text) AND (kind = ANY (ARRAY['dispatch'::text, 'replay'::text])));
--> statement-breakpoint
CREATE INDEX effect_attempts_started_lease_idx ON public.effect_attempts USING btree (lease_until) WHERE (status = 'started'::text);
--> statement-breakpoint
CREATE INDEX effect_evidence_effect_idx ON public.effect_evidence USING btree (effect_id, created_at);
--> statement-breakpoint
CREATE INDEX effect_previews_ws_idx ON public.effect_previews USING btree (workspace_id, environment_id, created_at);
--> statement-breakpoint
CREATE INDEX event_subscriptions_topic_idx ON public.event_subscriptions USING btree (topic_id);
--> statement-breakpoint
CREATE INDEX event_subscriptions_ws_idx ON public.event_subscriptions USING btree (workspace_id);
--> statement-breakpoint
CREATE UNIQUE INDEX event_topics_ws_name_unique ON public.event_topics USING btree (workspace_id, environment_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX events_idempotency_unique ON public.events USING btree (workspace_id, environment_id, topic_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
--> statement-breakpoint
CREATE INDEX events_topic_idx ON public.events USING btree (topic_id);
--> statement-breakpoint
CREATE INDEX events_trace_run_id_idx ON public.events USING btree (trace_run_id);
--> statement-breakpoint
CREATE INDEX events_ws_created_idx ON public.events USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX events_ws_environment_created_idx ON public.events USING btree (workspace_id, environment_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX function_run_calls_run_sequence_unique ON public.function_run_calls USING btree (run_row_id, sequence);
--> statement-breakpoint
CREATE INDEX function_runs_env_end_user_idx ON public.function_runs USING btree (environment_id, end_user_id);
--> statement-breakpoint
CREATE INDEX function_runs_function_idx ON public.function_runs USING btree (function_row_id, created_at);
--> statement-breakpoint
CREATE INDEX function_runs_plan_run_idx ON public.function_runs USING btree (plan_run_row_id);
--> statement-breakpoint
CREATE INDEX function_runs_workspace_created_idx ON public.function_runs USING btree (workspace_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX functions_env_name_unique ON public.functions USING btree (environment_id, name) WHERE (archived_at IS NULL);
--> statement-breakpoint
CREATE INDEX idx_action_versions_action_id ON public.action_versions USING btree (action_id);
--> statement-breakpoint
CREATE INDEX idx_action_versions_environment_id ON public.action_versions USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX idx_agent_versions_agent_id ON public.agent_versions USING btree (agent_id);
--> statement-breakpoint
CREATE INDEX idx_agent_versions_environment_id ON public.agent_versions USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX idx_agents_environment_id ON public.agents USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX idx_agents_workspace_id ON public.agents USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_api_key_history_api_key_id ON public.api_key_history USING btree (api_key_id);
--> statement-breakpoint
CREATE INDEX idx_api_key_history_workspace_id ON public.api_key_history USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_api_keys_environment_id ON public.api_keys USING btree (environment_id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_api_keys_key_hash ON public.api_keys USING btree (key_hash);
--> statement-breakpoint
CREATE INDEX idx_api_keys_workspace_id ON public.api_keys USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_archival_partition_date ON public.archival_tracking USING btree (partition_date);
--> statement-breakpoint
CREATE INDEX idx_archival_partition_name ON public.archival_tracking USING btree (partition_name);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_archival_partition_unique ON public.archival_tracking USING btree (partition_name, log_type);
--> statement-breakpoint
CREATE INDEX idx_archival_status ON public.archival_tracking USING btree (status);
--> statement-breakpoint
CREATE INDEX idx_environments_workspace_id ON public.environments USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_integration_connections_active ON public.integration_connections USING btree (workspace_id, is_active);
--> statement-breakpoint
CREATE INDEX idx_integration_connections_type ON public.integration_connections USING btree (workspace_id, type);
--> statement-breakpoint
CREATE INDEX idx_integration_connections_workspace ON public.integration_connections USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_member_environment_roles_environment_id ON public.member_environment_roles USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX idx_notifications_unread ON public.notifications USING btree (workspace_id, is_read);
--> statement-breakpoint
CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);
--> statement-breakpoint
CREATE INDEX idx_notifications_workspace_id ON public.notifications USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_oauth_states_expires ON public.oauth_states USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX idx_oauth_states_state ON public.oauth_states USING btree (state);
--> statement-breakpoint
CREATE INDEX idx_run_feedback_run_id ON public.run_feedback USING btree (run_id);
--> statement-breakpoint
CREATE INDEX idx_run_feedback_workspace_id ON public.run_feedback USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_runs_agent_id ON public.runs USING btree (agent_id);
--> statement-breakpoint
CREATE INDEX idx_runs_environment_id ON public.runs USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX idx_runs_workspace_id ON public.runs USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_runs_ws_started ON public.runs USING btree (workspace_id, started_at);
--> statement-breakpoint
CREATE INDEX idx_spans_parent ON public.spans USING btree (run_id, parent_span_id);
--> statement-breakpoint
CREATE INDEX idx_spans_run_id ON public.spans USING btree (run_id);
--> statement-breakpoint
CREATE INDEX idx_workspace_invitations_email ON public.workspace_invitations USING btree (email);
--> statement-breakpoint
CREATE INDEX idx_workspace_invitations_token ON public.workspace_invitations USING btree (token);
--> statement-breakpoint
CREATE INDEX idx_workspace_invitations_workspace_id ON public.workspace_invitations USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX idx_workspace_members_user_id ON public.workspace_members USING btree (user_id);
--> statement-breakpoint
CREATE INDEX impact_limits_ws_idx ON public.impact_limits USING btree (workspace_id, environment_id);
--> statement-breakpoint
CREATE INDEX impact_reservations_limit_state_idx ON public.impact_reservations USING btree (limit_id, state);
--> statement-breakpoint
CREATE INDEX invocation_resolutions_ws_idx ON public.invocation_resolutions USING btree (workspace_id, environment_id);
--> statement-breakpoint
CREATE INDEX key_budgets_workspace_idx ON public.key_budgets USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX mcp_upstreams_check_due_idx ON public.mcp_upstreams USING btree (next_check_at) WHERE (archived_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_upstreams_env_name_unique ON public.mcp_upstreams USING btree (workspace_id, environment_id, name) WHERE (archived_at IS NULL);
--> statement-breakpoint
CREATE INDEX mcp_upstreams_environment_idx ON public.mcp_upstreams USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX message_enqueue_outbox_created_idx ON public.message_enqueue_outbox USING btree (created_at);
--> statement-breakpoint
CREATE INDEX message_quota_day_idx ON public.message_quota_reservations USING btree (workspace_id, day);
--> statement-breakpoint
CREATE INDEX messages_event_id_idx ON public.messages USING btree (event_id);
--> statement-breakpoint
CREATE INDEX messages_trace_run_id_idx ON public.messages USING btree (trace_run_id);
--> statement-breakpoint
CREATE INDEX messages_ws_environment_created_idx ON public.messages USING btree (workspace_id, environment_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX notification_user_preferences_ws_user_unique ON public.notification_user_preferences USING btree (workspace_id, user_id);
--> statement-breakpoint
CREATE INDEX oauth_access_token_authorization_code_id_idx ON public.oauth_access_token USING btree (authorization_code_id);
--> statement-breakpoint
CREATE INDEX oauth_access_token_client_id_idx ON public.oauth_access_token USING btree (client_id);
--> statement-breakpoint
CREATE INDEX oauth_access_token_user_id_idx ON public.oauth_access_token USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_client_resource_client_resource_idx ON public.oauth_client_resource USING btree (client_id, resource_id);
--> statement-breakpoint
CREATE INDEX oauth_client_resource_resource_id_idx ON public.oauth_client_resource USING btree (resource_id);
--> statement-breakpoint
CREATE INDEX oauth_client_user_id_idx ON public.oauth_client USING btree (user_id);
--> statement-breakpoint
CREATE INDEX oauth_connections_end_user_idx ON public.oauth_connections USING btree (environment_id, subject_end_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_connections_end_user_unique ON public.oauth_connections USING btree (environment_id, integration_key, subject_end_user_id) WHERE ((subject_end_user_id IS NOT NULL) AND (revoked_at IS NULL) AND (pending_confirmation_until IS NULL));
--> statement-breakpoint
CREATE INDEX oauth_connections_workspace_env_idx ON public.oauth_connections USING btree (workspace_id, environment_id);
--> statement-breakpoint
CREATE INDEX oauth_consent_user_id_idx ON public.oauth_consent USING btree (user_id);
--> statement-breakpoint
CREATE INDEX oauth_refresh_token_authorization_code_id_idx ON public.oauth_refresh_token USING btree (authorization_code_id);
--> statement-breakpoint
CREATE INDEX oauth_refresh_token_client_id_idx ON public.oauth_refresh_token USING btree (client_id);
--> statement-breakpoint
CREATE INDEX oauth_refresh_token_user_id_idx ON public.oauth_refresh_token USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_workspace_binding_user_client_idx ON public.oauth_workspace_binding USING btree (user_id, client_id);
--> statement-breakpoint
CREATE INDEX oauth_workspace_binding_workspace_idx ON public.oauth_workspace_binding USING btree (workspace_id);
--> statement-breakpoint
CREATE INDEX queues_ws_environment_idx ON public.queues USING btree (workspace_id, environment_id);
--> statement-breakpoint
CREATE UNIQUE INDEX queues_ws_environment_name_unique ON public.queues USING btree (workspace_id, environment_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX secret_stores_ws_env_name_unique ON public.secret_stores USING btree (workspace_id, environment_id, name);
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON public.session USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX sign_off_requests_pending_dedupe ON public.sign_off_requests USING btree (request_digest) WHERE (status = ANY (ARRAY['pending'::text, 'applying'::text]));
--> statement-breakpoint
CREATE INDEX sign_off_requests_status_expires_idx ON public.sign_off_requests USING btree (status, expires_at);
--> statement-breakpoint
CREATE INDEX sign_off_requests_ws_status_idx ON public.sign_off_requests USING btree (workspace_id, status, created_at);
--> statement-breakpoint
CREATE INDEX slack_approval_actions_approval_idx ON public.slack_approval_actions USING btree (approval_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX slack_approval_messages_approval_unique ON public.slack_approval_messages USING btree (approval_id);
--> statement-breakpoint
CREATE INDEX slack_approval_messages_lookup_idx ON public.slack_approval_messages USING btree (slack_team_id, channel_id, message_ts);
--> statement-breakpoint
CREATE UNIQUE INDEX slack_approval_routes_environment_unique ON public.slack_approval_routes USING btree (environment_id);
--> statement-breakpoint
CREATE INDEX slack_approval_routes_workspace_idx ON public.slack_approval_routes USING btree (workspace_id);
--> statement-breakpoint
CREATE UNIQUE INDEX slack_user_links_slack_user_unique ON public.slack_user_links USING btree (workspace_id, slack_team_id, slack_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX slack_user_links_user_unique ON public.slack_user_links USING btree (workspace_id, slack_team_id, user_id);
--> statement-breakpoint
CREATE INDEX sso_provider_organization_id_idx ON public.sso_provider USING btree (organization_id);
--> statement-breakpoint
CREATE INDEX sso_sessions_provider_id_idx ON public.sso_sessions USING btree (provider_id);
--> statement-breakpoint
CREATE INDEX two_factor_user_id_idx ON public."twoFactor" USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX usage_logs_workspace_date_unique ON public.usage_logs USING btree (workspace_id, date);
--> statement-breakpoint
CREATE INDEX user_email_lower_idx ON public."user" USING btree (lower(email));
--> statement-breakpoint
CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);
--> statement-breakpoint
CREATE INDEX workspace_action_credits_expiry_idx ON public.workspace_action_credits USING btree (workspace_id, expires_at);
--> statement-breakpoint
CREATE INDEX workspace_scim_group_members_user_idx ON public.workspace_scim_group_members USING btree (scim_user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_scim_groups_workspace_display_name_unique ON public.workspace_scim_groups USING btree (workspace_id, lower(display_name));
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_scim_role_mappings_workspace_group_unique ON public.workspace_scim_role_mappings USING btree (workspace_id, lower(group_name));
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_scim_users_workspace_external_id_unique ON public.workspace_scim_users USING btree (workspace_id, external_id) WHERE (external_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_scim_users_workspace_user_name_unique ON public.workspace_scim_users USING btree (workspace_id, lower(user_name));
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_scim_users_workspace_user_unique ON public.workspace_scim_users USING btree (workspace_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_secrets_ws_name_unique ON public.workspace_secrets USING btree (workspace_id, environment_id, name);
--> statement-breakpoint
CREATE TRIGGER action_effects_guard BEFORE UPDATE ON public.action_effects FOR EACH ROW EXECUTE FUNCTION public.anlyon_guard_action_effect();
--> statement-breakpoint
CREATE TRIGGER approval_policies_no_truncate BEFORE TRUNCATE ON public.approval_policies FOR EACH STATEMENT EXECUTE FUNCTION public.anlyon_protect_policy_history();
--> statement-breakpoint
CREATE TRIGGER approval_policy_capture_version AFTER INSERT OR DELETE OR UPDATE ON public.approval_policies FOR EACH ROW EXECUTE FUNCTION public.anlyon_capture_policy_version();
--> statement-breakpoint
CREATE TRIGGER approval_policy_history_immutable BEFORE DELETE OR UPDATE ON public.approval_policy_versions FOR EACH ROW EXECUTE FUNCTION public.anlyon_protect_policy_history();
--> statement-breakpoint
CREATE TRIGGER approval_policy_history_no_truncate BEFORE TRUNCATE ON public.approval_policy_versions FOR EACH STATEMENT EXECUTE FUNCTION public.anlyon_protect_policy_history();
--> statement-breakpoint
CREATE TRIGGER approval_policy_version_before_update BEFORE UPDATE ON public.approval_policies FOR EACH ROW EXECUTE FUNCTION public.anlyon_policy_version_before_update();
--> statement-breakpoint
CREATE TRIGGER audit_events_guard_delete BEFORE DELETE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_guard_removal();
--> statement-breakpoint
CREATE TRIGGER audit_events_guard_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_guard_removal();
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.audit_events_refuse_update();
--> statement-breakpoint
CREATE TRIGGER effect_evidence_immutable BEFORE DELETE OR UPDATE ON public.effect_evidence FOR EACH ROW EXECUTE FUNCTION public.anlyon_protect_effect_evidence();
--> statement-breakpoint
CREATE TRIGGER effect_evidence_no_truncate BEFORE TRUNCATE ON public.effect_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.anlyon_protect_effect_evidence();
--> statement-breakpoint
CREATE TRIGGER invocation_resolutions_immutable BEFORE DELETE OR UPDATE ON public.invocation_resolutions FOR EACH ROW EXECUTE FUNCTION public.anlyon_protect_invocation_resolution();
--> statement-breakpoint
CREATE TRIGGER invocation_resolutions_no_truncate BEFORE TRUNCATE ON public.invocation_resolutions FOR EACH STATEMENT EXECUTE FUNCTION public.anlyon_protect_invocation_resolution();
--> statement-breakpoint
ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_action_id_actions_id_fk FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_invocation_id_action_invocations_id_fk FOREIGN KEY (invocation_id) REFERENCES public.action_invocations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_effects
    ADD CONSTRAINT action_effects_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_invocations
    ADD CONSTRAINT action_invocations_action_id_actions_id_fk FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_invocations
    ADD CONSTRAINT action_invocations_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_invocations
    ADD CONSTRAINT action_invocations_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_versions
    ADD CONSTRAINT action_versions_action_id_actions_id_fk FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_versions
    ADD CONSTRAINT action_versions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.action_versions
    ADD CONSTRAINT action_versions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_current_version_id_fk FOREIGN KEY (current_version_id) REFERENCES public.agent_versions(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.alert_history
    ADD CONSTRAINT alert_history_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.api_key_history
    ADD CONSTRAINT api_key_history_api_key_id_api_keys_id_fk FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.api_key_history
    ADD CONSTRAINT api_key_history_rotated_by_user_id_fk FOREIGN KEY (rotated_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.api_key_history
    ADD CONSTRAINT api_key_history_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_advice
    ADD CONSTRAINT approval_advice_approval_id_approvals_id_fk FOREIGN KEY (approval_id) REFERENCES public.approvals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_advice
    ADD CONSTRAINT approval_advice_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_decisions
    ADD CONSTRAINT approval_decisions_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.approvals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policy_versions
    ADD CONSTRAINT approval_policy_versions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approval_policy_versions
    ADD CONSTRAINT approval_policy_versions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.assistant_usage
    ADD CONSTRAINT assistant_usage_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.audit_lifecycle
    ADD CONSTRAINT audit_lifecycle_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.audit_settings
    ADD CONSTRAINT audit_settings_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.audit_sink_dead_letters
    ADD CONSTRAINT audit_sink_dead_letters_sink_id_audit_sinks_id_fk FOREIGN KEY (sink_id) REFERENCES public.audit_sinks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.audit_sink_dead_letters
    ADD CONSTRAINT audit_sink_dead_letters_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.audit_sinks
    ADD CONSTRAINT audit_sinks_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.budget_periods
    ADD CONSTRAINT budget_periods_api_key_id_api_keys_id_fk FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_api_key_id_api_keys_id_fk FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.budget_reservations
    ADD CONSTRAINT budget_reservations_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_secrets
    ADD CONSTRAINT delivery_secrets_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.delivery_secrets
    ADD CONSTRAINT delivery_secrets_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.effect_attempts
    ADD CONSTRAINT effect_attempts_effect_scope_fk FOREIGN KEY (effect_id, workspace_id, environment_id) REFERENCES public.action_effects(id, workspace_id, environment_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.effect_evidence
    ADD CONSTRAINT effect_evidence_effect_scope_fk FOREIGN KEY (effect_id, workspace_id, environment_id) REFERENCES public.action_effects(id, workspace_id, environment_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.effect_previews
    ADD CONSTRAINT effect_previews_action_id_actions_id_fk FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.effect_previews
    ADD CONSTRAINT effect_previews_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.effect_previews
    ADD CONSTRAINT effect_previews_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.end_user_erasures
    ADD CONSTRAINT end_user_erasures_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.end_user_erasures
    ADD CONSTRAINT end_user_erasures_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.environment_oauth_apps
    ADD CONSTRAINT environment_oauth_apps_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.environment_oauth_apps
    ADD CONSTRAINT environment_oauth_apps_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.event_subscriptions
    ADD CONSTRAINT event_subscriptions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.event_subscriptions
    ADD CONSTRAINT event_subscriptions_mcp_environment_id_environments_id_fk FOREIGN KEY (mcp_environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.event_subscriptions
    ADD CONSTRAINT event_subscriptions_topic_id_event_topics_id_fk FOREIGN KEY (topic_id) REFERENCES public.event_topics(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.event_subscriptions
    ADD CONSTRAINT event_subscriptions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.event_topics
    ADD CONSTRAINT event_topics_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.event_topics
    ADD CONSTRAINT event_topics_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_topic_id_event_topics_id_fk FOREIGN KEY (topic_id) REFERENCES public.event_topics(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_run_calls
    ADD CONSTRAINT function_run_calls_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_run_calls
    ADD CONSTRAINT function_run_calls_run_row_id_function_runs_id_fk FOREIGN KEY (run_row_id) REFERENCES public.function_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_run_calls
    ADD CONSTRAINT function_run_calls_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_function_row_id_functions_id_fk FOREIGN KEY (function_row_id) REFERENCES public.functions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_function_version_row_id_function_versions_id_fk FOREIGN KEY (function_version_row_id) REFERENCES public.function_versions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_plan_run_row_id_function_runs_id_fk FOREIGN KEY (plan_run_row_id) REFERENCES public.function_runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_runs
    ADD CONSTRAINT function_runs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_versions
    ADD CONSTRAINT function_versions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_versions
    ADD CONSTRAINT function_versions_function_row_id_functions_id_fk FOREIGN KEY (function_row_id) REFERENCES public.functions(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.function_versions
    ADD CONSTRAINT function_versions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.impact_limit_periods
    ADD CONSTRAINT impact_limit_periods_limit_id_impact_limits_id_fk FOREIGN KEY (limit_id) REFERENCES public.impact_limits(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.impact_limits
    ADD CONSTRAINT impact_limits_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.impact_limits
    ADD CONSTRAINT impact_limits_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.impact_reservations
    ADD CONSTRAINT impact_reservations_effect_scope_fk FOREIGN KEY (effect_id, workspace_id, environment_id) REFERENCES public.action_effects(id, workspace_id, environment_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.impact_reservations
    ADD CONSTRAINT impact_reservations_limit_id_impact_limits_id_fk FOREIGN KEY (limit_id) REFERENCES public.impact_limits(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.instance_admins
    ADD CONSTRAINT instance_admins_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.invocation_resolutions
    ADD CONSTRAINT invocation_resolutions_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.invocation_resolutions
    ADD CONSTRAINT invocation_resolutions_invocation_id_action_invocations_id_fk FOREIGN KEY (invocation_id) REFERENCES public.action_invocations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.invocation_resolutions
    ADD CONSTRAINT invocation_resolutions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.key_budgets
    ADD CONSTRAINT key_budgets_api_key_id_api_keys_id_fk FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.key_budgets
    ADD CONSTRAINT key_budgets_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_upstreams
    ADD CONSTRAINT mcp_upstreams_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.mcp_upstreams
    ADD CONSTRAINT mcp_upstreams_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.member_environment_roles
    ADD CONSTRAINT member_environment_roles_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.member_environment_roles
    ADD CONSTRAINT member_environment_roles_granted_by_user_id_fk FOREIGN KEY (granted_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.member_environment_roles
    ADD CONSTRAINT member_environment_roles_membership_fk FOREIGN KEY (workspace_id, user_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.member_environment_roles
    ADD CONSTRAINT member_environment_roles_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.message_enqueue_outbox
    ADD CONSTRAINT message_enqueue_outbox_message_id_messages_message_id_fk FOREIGN KEY (message_id) REFERENCES public.messages(message_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.message_quota_reservations
    ADD CONSTRAINT message_quota_reservations_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_queue_id_queues_id_fk FOREIGN KEY (queue_id) REFERENCES public.queues(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_delivery_log
    ADD CONSTRAINT notification_delivery_log_notification_id_notifications_id_fk FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_delivery_log
    ADD CONSTRAINT notification_delivery_log_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_user_preferences
    ADD CONSTRAINT notification_user_preferences_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_user_preferences
    ADD CONSTRAINT notification_user_preferences_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_refresh_id_oauth_refresh_token_id_fk FOREIGN KEY (refresh_id) REFERENCES public.oauth_refresh_token(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client_resource
    ADD CONSTRAINT oauth_client_resource_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client_resource
    ADD CONSTRAINT oauth_client_resource_resource_id_oauth_resource_identifier_fk FOREIGN KEY (resource_id) REFERENCES public.oauth_resource(identifier) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_client
    ADD CONSTRAINT oauth_client_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_connections
    ADD CONSTRAINT oauth_connections_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_connections
    ADD CONSTRAINT oauth_connections_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_workspace_binding
    ADD CONSTRAINT oauth_workspace_binding_client_id_oauth_client_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_workspace_binding
    ADD CONSTRAINT oauth_workspace_binding_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_workspace_binding
    ADD CONSTRAINT oauth_workspace_binding_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.oauth_workspace_binding
    ADD CONSTRAINT oauth_workspace_binding_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.queues
    ADD CONSTRAINT queues_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.queues
    ADD CONSTRAINT queues_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.run_feedback
    ADD CONSTRAINT run_feedback_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.run_feedback
    ADD CONSTRAINT run_feedback_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.run_feedback
    ADD CONSTRAINT run_feedback_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.secret_store_settings
    ADD CONSTRAINT secret_store_settings_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.secret_stores
    ADD CONSTRAINT secret_stores_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.secret_stores
    ADD CONSTRAINT secret_stores_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.sign_off_requests
    ADD CONSTRAINT sign_off_requests_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.sign_off_requests
    ADD CONSTRAINT sign_off_requests_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_actions
    ADD CONSTRAINT slack_approval_actions_approval_id_approvals_id_fk FOREIGN KEY (approval_id) REFERENCES public.approvals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_actions
    ADD CONSTRAINT slack_approval_actions_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_actions
    ADD CONSTRAINT slack_approval_actions_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_messages
    ADD CONSTRAINT slack_approval_messages_approval_id_approvals_id_fk FOREIGN KEY (approval_id) REFERENCES public.approvals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_messages
    ADD CONSTRAINT slack_approval_messages_integration_id_integration_connections_ FOREIGN KEY (integration_id) REFERENCES public.integration_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_messages
    ADD CONSTRAINT slack_approval_messages_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_routes
    ADD CONSTRAINT slack_approval_routes_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_routes
    ADD CONSTRAINT slack_approval_routes_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_routes
    ADD CONSTRAINT slack_approval_routes_integration_id_integration_connections_id FOREIGN KEY (integration_id) REFERENCES public.integration_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_approval_routes
    ADD CONSTRAINT slack_approval_routes_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_user_links
    ADD CONSTRAINT slack_user_links_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.slack_user_links
    ADD CONSTRAINT slack_user_links_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.spans
    ADD CONSTRAINT spans_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.spans
    ADD CONSTRAINT spans_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.spans
    ADD CONSTRAINT spans_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_organization_id_workspaces_id_fk FOREIGN KEY (organization_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.sso_sessions
    ADD CONSTRAINT sso_sessions_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.trace_archives
    ADD CONSTRAINT trace_archives_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public."twoFactor"
    ADD CONSTRAINT "twoFactor_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.usage_logs
    ADD CONSTRAINT usage_logs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_action_credits
    ADD CONSTRAINT workspace_action_credits_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_assistant_settings
    ADD CONSTRAINT workspace_assistant_settings_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_budget_periods
    ADD CONSTRAINT workspace_budget_periods_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_budgets
    ADD CONSTRAINT workspace_budgets_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_defaults
    ADD CONSTRAINT workspace_defaults_updated_by_user_id_fk FOREIGN KEY (updated_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_defaults
    ADD CONSTRAINT workspace_defaults_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_invited_by_user_id_fk FOREIGN KEY (invited_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_invited_user_id_user_id_fk FOREIGN KEY (invited_user_id) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_invited_by_user_id_fk FOREIGN KEY (invited_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_configs
    ADD CONSTRAINT workspace_scim_configs_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_configs
    ADD CONSTRAINT workspace_scim_configs_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_group_members
    ADD CONSTRAINT workspace_scim_group_members_group_id_workspace_scim_groups_id_ FOREIGN KEY (group_id) REFERENCES public.workspace_scim_groups(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_group_members
    ADD CONSTRAINT workspace_scim_group_members_scim_user_id_workspace_scim_users_ FOREIGN KEY (scim_user_id) REFERENCES public.workspace_scim_users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_groups
    ADD CONSTRAINT workspace_scim_groups_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_role_mappings
    ADD CONSTRAINT workspace_scim_role_mappings_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_users
    ADD CONSTRAINT workspace_scim_users_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_scim_users
    ADD CONSTRAINT workspace_scim_users_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_secret_store_id_secret_stores_id_fk FOREIGN KEY (secret_store_id) REFERENCES public.secret_stores(id);
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_secrets
    ADD CONSTRAINT workspace_secrets_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_sso_connections
    ADD CONSTRAINT workspace_sso_connections_created_by_user_id_fk FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_sso_connections
    ADD CONSTRAINT workspace_sso_connections_provider_id_sso_provider_provider_id_ FOREIGN KEY (provider_id) REFERENCES public.sso_provider(provider_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_sso_connections
    ADD CONSTRAINT workspace_sso_connections_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.workspace_usage_periods
    ADD CONSTRAINT workspace_usage_periods_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
