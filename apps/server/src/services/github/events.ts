/**
 * GitHub webhook payload shapes, as much of them as the handlers read.
 * Deliberately loose: GitHub adds fields freely and nothing here validates.
 */

export interface Sender {
  login?: string;
  type?: string;
}

export interface LabeledEvent {
  action?: string;
  label?: { name?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    /** Present on opened/reopened; the issue may be created WITH agent:fix. */
    labels?: Array<{ name?: string } | string>;
  };
  repository?: { full_name?: string; default_branch?: string };
  sender?: Sender;
  installation?: { id?: number };
}

export interface CheckRunEvent {
  action?: string;
  check_run?: {
    name?: string;
    conclusion?: string | null;
    html_url?: string;
    head_sha?: string;
    check_suite?: { head_branch?: string };
    pull_requests?: Array<{ number?: number }>;
  };
  repository?: { full_name?: string };
  sender?: Sender;
}

export interface StatusEvent {
  state?: string;
  context?: string;
  target_url?: string;
  commit?: { sha?: string };
  branches?: Array<{ name?: string }>;
  repository?: { full_name?: string };
  sender?: Sender;
}

export interface ReviewEvent {
  action?: string;
  review?: {
    state?: string;
    body?: string | null;
    html_url?: string;
    user?: Sender;
  };
  comment?: {
    body?: string | null;
    html_url?: string;
    user?: Sender;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    side?: string | null;
    subject_type?: string;
    diff_hunk?: string;
    in_reply_to_id?: number;
  };
  pull_request?: { number?: number; title?: string; html_url?: string };
  repository?: { full_name?: string };
  sender?: Sender;
}

export interface IssueCommentEvent {
  action?: string;
  comment?: { body?: string | null; html_url?: string; user?: Sender };
  issue?: { number?: number; pull_request?: { url?: string } };
  repository?: { full_name?: string };
  sender?: Sender;
}

export interface PushEvent {
  ref?: string;
  after?: string;
  deleted?: boolean;
  commits?: unknown[];
  repository?: { full_name?: string };
  sender?: Sender;
}

export interface PullRequestEvent {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    html_url?: string;
    head?: { ref?: string };
  };
  repository?: { full_name?: string };
  sender?: Sender;
}

/** The instruction a labeled issue turns into. */
