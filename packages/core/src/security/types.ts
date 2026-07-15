export const FINDING_STATUSES = [
  "open",
  "triaged",
  "fixing",
  "resolved",
  "accepted_risk",
  "dismissed",
  "reopened",
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const VERIFICATION_STATUSES = ["unverified", "verified", "failed", "stale"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type FindingEvidence = {
  path: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
};

export type FindingSource = {
  scanner: string;
  version: string;
  ruleId: string;
};

export type Finding = {
  id: string;
  fingerprint: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: "low" | "medium" | "high";
  category: string;
  cwe?: string;
  recommendation: string;
  evidence: FindingEvidence[];
  source: FindingSource;
  status: FindingStatus;
  verificationStatus: VerificationStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  scanRunId: string;
};

export type ScanRun = {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  scanner: string;
  scannerVersion: string;
  findingIds: string[];
  error?: string;
};

export type ThreatModelEvidence = Pick<FindingEvidence, "path" | "lineStart" | "lineEnd">;

export type ThreatModelItem = {
  name: string;
  description: string;
  evidence: ThreatModelEvidence[];
};

export type Threat = {
  id: string;
  title: string;
  scenario: string;
  affectedAssets: string[];
  entryPoints: string[];
  trustBoundaries: string[];
  mitigations: string[];
  severity: FindingSeverity;
  evidence: ThreatModelEvidence[];
};

export type ThreatModel = {
  id: string;
  createdAt: string;
  repository: string;
  summary: string;
  assets: ThreatModelItem[];
  entryPoints: ThreatModelItem[];
  trustBoundaries: ThreatModelItem[];
  dataFlows: ThreatModelItem[];
  threats: Threat[];
};

export type VerificationCommandResult = {
  kind: "verify" | "lint";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type FixAttempt = {
  id: string;
  findingId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "agent_failed" | "verification_failed" | "verified";
  sessionCompleted?: boolean;
  commands: VerificationCommandResult[];
  scanRunId?: string;
  notes?: string;
};

type EventBase = { version: 1; id: string; at: string };

export type SecurityEvent =
  | (EventBase & { type: "scan.started"; scan: ScanRun })
  | (EventBase & {
      type: "scan.completed";
      scanId: string;
      status: "completed" | "failed";
      findingIds: string[];
      error?: string;
    })
  | (EventBase & { type: "finding.detected"; finding: Finding })
  | (EventBase & {
      type: "finding.status_changed";
      findingId: string;
      from: FindingStatus;
      to: FindingStatus;
      reason: string;
    })
  | (EventBase & {
      type: "finding.verification_changed";
      findingId: string;
      from: VerificationStatus;
      to: VerificationStatus;
      reason: string;
      scanRunId?: string;
    })
  | (EventBase & { type: "fix.started"; fix: FixAttempt })
  | (EventBase & { type: "fix.completed"; fix: FixAttempt })
  | (EventBase & { type: "threat_model.created"; threatModel: ThreatModel });

export type SecurityState = {
  findings: Map<string, Finding>;
  scans: Map<string, ScanRun>;
  fixes: Map<string, FixAttempt>;
  threatModels: Map<string, ThreatModel>;
  events: SecurityEvent[];
};

export type SecurityEvidencePackage = {
  schemaVersion: 1;
  generatedAt: string;
  repository: string;
  findings: Finding[];
  scans: ScanRun[];
  fixes: FixAttempt[];
  threatModels: ThreatModel[];
  events: SecurityEvent[];
  disclaimer: string;
};
