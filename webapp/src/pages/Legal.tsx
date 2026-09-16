import { Link } from "react-router-dom";

type Block =
  | { h?: string; p: string }
  | { h?: string; list: string[] };

type Doc = { title: string; updated: string; lead?: string; blocks: Block[]; contact?: string };

const PRIVACY: Doc = {
  title: "Privacy Policy",
  updated: "September 2026 (public beta)",
  lead:
    "highlights.live (\"the Service\") is a product operated by Ad Astra Labs (\"we\", \"us\", \"our\"). This policy explains what data we collect, how we use it, how long we keep it, and the choices you have. By using the Service you agree to this policy and our Terms of Service.",
  blocks: [
    { h: "What we collect", list: [
      "Contact / account information — your email when you join the waitlist or create an account, and hashed authentication credentials.",
      "Video you provide — the live streams and VODs you connect, upload, or point us at, processed to detect moments and generate clips.",
      "Generated clips and metadata — the highlight clips we create plus event type, timestamps, and the reason captured.",
      "Quota / usage information — how many clips you generate per month against your plan quota.",
      "Technical data — IP address, browser/device type, and basic request logs for security and rate limiting.",
    ] },
    { h: "How we use your data", p: "To provide and operate the Service (process your video, generate and deliver clips, display them in your feed, enforce quotas); to manage your account and waitlist; for security and anti-abuse (including the beta invite gate and rate limits); and for product improvement using only aggregate, de-identified statistics. We do not use your uploaded video to train third-party models." },
    { h: "Data retention", p: "Clips on the free beta are retained for 30 days. Source video is retained only as long as needed to generate your clips, and no longer than 30 days. You may request deletion at any time — see the Data Retention note. Account, email, and quota records are kept for as long as your account exists, subject to legal obligations." },
    { h: "Sharing and disclosure", p: "We do not sell your personal data and do not serve ads based on it. We share data only with service providers needed to operate the Service (for example, cloud compute/GPU and hosting providers), bound to use it only to provide the Service, and we may disclose data if required by law." },
    { h: "Your choices", list: [
      "Deletion — request deletion of clips, source video, or your account at any time.",
      "Correction — update your account email in the console or by contacting us.",
      "Communication — stop marketing emails at any time; we still send essential service notices.",
    ] },
    { h: "Children", p: "The Service is intended for users aged 16 and older. We do not knowingly collect personal data from children." },
    { h: "Changes & contact", p: "We may update this policy. Questions: privacy@highlights.live / support@highlights.live." },
  ],
};

const TERMS: Doc = {
  title: "Terms of Service",
  updated: "September 2026 (public beta)",
  lead:
    "These Terms govern your access to highlights.live (\"the Service\"), operated by Ad Astra Labs. By using the Service you agree to these Terms and our Privacy Policy.",
  blocks: [
    { h: "1. The Service", p: "highlights.live uses AI to detect and generate highlight clips from sports and esports content — live streams or VODs you connect or upload. The Service is in public beta: it is evolving, features may change or be removed, and we make no guarantee that any output is available or correct at any time." },
    { h: "2. Your account", list: [
      "Provide accurate information and keep your credentials secure.",
      "Access is invite-gated during beta: use the product only if invited or your waitlisted email is activated. Invite codes are single-use and non-transferable.",
      "Free (Beta): 10 generated clips/month, a \"highlights.live\" watermark, and 30 days of clip retention. No card is required during the beta; no charge is made during the beta.",
      "Quotas reset per calendar month; we may pause or limit usage to protect the Service and bound beta cost.",
    ] },
    { h: "3. Acceptable use", p: "You agree not to upload or process content you do not have the right to use (including infringing content), illegal or harmful content, to interfere with, scrape, overload, or gain unauthorized access to the Service or other users' data, to bypass the invite gate, quotas, or rate limits, or to violate applicable law." },
    { h: "4. Your content and rights", p: "You retain all rights in the video you provide and the clips generated for you. By providing content you grant us a limited, non-exclusive, royalty-free license to use, store, process, reproduce, and display it solely to operate the Service for you. You represent that you own or have all necessary rights to provide the content and grant this license." },
    { h: "5. Generated output", p: "Clips are produced by automated AI analysis. Generative output is provided \"as is\" and is not guaranteed to be accurate, complete, or free of errors — including mis-labelled events or wrong timestamps. You are responsible for reviewing any clip you publish or share." },
    { h: "6. Disclaimers", p: "The Service is provided \"as is\" and \"as available\", without warranties of any kind, including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant uninterrupted, secure, or error-free operation, or that stored video or clips will not be lost. To the maximum extent permitted by law, our aggregate liability will not exceed amounts you paid in the 3 months preceding a claim (zero during the no-charge beta), and we are not liable for indirect, incidental, special, consequential, or punitive damages." },
    { h: "7. Termination", p: "We may suspend or terminate access at any time and for any reason, including a breach of these Terms. Upon termination you may request deletion of your data per the Data Retention note." },
    { h: "8. Changes & governing law", p: "We may update these Terms; material changes take effect on the posted date. These Terms are governed by the laws of the jurisdiction in which Ad Astra Labs is established. Questions: legal@highlights.live." },
  ],
};

const RETENTION: Doc = {
  title: "Data Retention",
  updated: "September 2026 (public beta)",
  lead:
    "This note describes how long we keep video and clips you provide through highlights.live during the public beta. It is part of our Privacy Policy.",
  blocks: [
    { h: "Summary", list: [
      "Generated clips are retained for 30 days on the free beta plan.",
      "Source video you upload or connect is retained only as long as needed to generate and deliver your clips, and no longer than 30 days on the free beta.",
      "You can request deletion at any time, and we will honor it.",
    ] },
    { h: "What we retain", list: [
      "Source video (uploaded / connected live + VOD streams) — only as long as needed to generate clips, at most 30 days.",
      "Generated highlight clips + clip metadata — 30 days.",
      "Your account, email, and usage (quota) records — for as long as your account exists.",
      "Raw processing frames / intermediate analysis data — deleted once a clip is generated and delivered.",
    ] },
    { h: "Deletion on request", p: "You can request deletion of any uploaded source video, generated clip, or your entire account by contacting support@highlights.live. We process deletion requests within 5 business days of a verifiable request linked to the account that owns the data. Deleting your account removes your account, stored email, and quota records (subject to legal retention requirements)." },
    { h: "Your content stays yours", p: "We do not resell or distribute your uploaded content. You retain ownership of the clips and source video you provide, subject only to the limited license in the Terms of Service needed to run the Service for you." },
  ],
};

const DOCS: Record<string, Doc> = {
  privacy: PRIVACY,
  terms: TERMS,
  retention: RETENTION,
};

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-6">
      {blocks.map((b, i) => (
        <section key={i}>
          {b.h && <h2 className="mb-2 text-xl font-black text-white">{b.h}</h2>}
          {"p" in b && b.p ? <p className="text-slate-ink leading-relaxed">{b.p}</p> : null}
          {"list" in b && b.list ? (
            <ul className="list-disc space-y-2 pl-5 text-slate-ink leading-relaxed">
              {b.list.map((li, j) => (
                <li key={j}>{li}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function Legal({ kind }: { kind: "privacy" | "terms" | "retention" }) {
  const doc = DOCS[kind] ?? PRIVACY;
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Link to="/" className="mb-6 inline-block text-sm text-neon">
        ← Back to highlights.live
      </Link>
      <h1 className="text-3xl font-black text-white">{doc.title}</h1>
      <p className="mt-1 text-sm text-mut">Effective: {doc.updated}</p>
      {doc.lead && <p className="mt-4 text-slate-ink leading-relaxed">{doc.lead}</p>}
      <div className="mt-8">
        <Blocks blocks={doc.blocks} />
      </div>
      <p className="mt-10 border-t border-mut/30 pt-4 text-sm text-mut">
        {doc.title} © 2026 Ad Astra Labs · highlights.live
      </p>
    </div>
  );
}
