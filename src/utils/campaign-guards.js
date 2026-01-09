const ALLOWED_TRANSITIONS = {
  draft: ["scheduled"],
  scheduled: ["running", "paused", "stopped"],
  running: ["paused", "completed", "stopped"],
  paused: ["running", "stopped"],
};

export function assertCampaignTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid campaign transition ${from} → ${to}`);
  }
}
