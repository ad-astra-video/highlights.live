// Shared copy for waitlist->invite emails. Imported by BOTH the API server
// (admin invite route) and the email-runner allocator so the invite copy lives
// in one place and the two never drift. The allocator (ADAAAA-2555) enqueues
// this same message for each allocated waitlist signup.
export interface InviteMail {
  subject: string;
  body: string;
}

export function composeInviteEmail(publicBaseUrl: string): InviteMail {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    subject: "You're invited to highlights.live beta",
    body: `You're invited! Your highlights.live beta account is ready to activate.\n\nOpen ${base}/auth and choose "Create account" to get started.`,
  };
}
