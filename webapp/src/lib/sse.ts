// Tiny SSE reader built on fetch's ReadableStream, so the Authorization header
// (Bearer token) can be sent — native EventSource cannot set headers. Parses the
// `event:` / `data:` frame format and calls onEvent(name, parsedJson) per frame.
export async function readSSE(
  url: string,
  token: string | null,
  onEvent: (name: string, data: any) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`event stream failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue; // heartbeat / empty
      try {
        onEvent(event, JSON.parse(data));
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
