export type TicketStatus = "open" | "assigned" | "in_progress" | "done" | "failed";
export type TicketSource = "dashboard" | "slack";

export interface Ticket {
  id: number;
  title: string;
  description: string;
  status: TicketStatus;
  source: TicketSource;
  created_by: string;
  slack_channel: string | null;
  slack_thread_ts: string | null;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "running" | "done" | "failed";

export interface Run {
  id: number;
  ticket_id: number;
  status: RunStatus;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  num_turns: number;
  result_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export type EventType = "thinking" | "assistant" | "tool" | "system" | "result" | "error";

export interface TicketEvent {
  id: number;
  ticket_id: number;
  run_id: number | null;
  type: EventType;
  content: string;
  created_at: string;
}
