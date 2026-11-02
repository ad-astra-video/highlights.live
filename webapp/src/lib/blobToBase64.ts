/** Base64 payload of a FileReader data URL.
 *
 * `data:<mime>;base64,<payload>` — the MIME itself can contain a comma, which
 * is exactly what a MediaRecorder produces when it records video + audio:
 * `video/webm;codecs=vp9,opus`. Splitting on the FIRST comma (the old
 * implementation) then returns `opus;base64,<payload>` instead of the payload,
 * so `Buffer.from(..., "base64")` stores 7 bytes of garbage and the session
 * recording is corrupt — every browser highlight ends with an empty clipUri
 * (ADAAAA-7724). Anchor on the `;base64,` marker instead. */
export function dataUrlToBase64(dataUrl: string): string {
  const marker = ";base64,";
  const at = dataUrl.indexOf(marker);
  if (at >= 0) return dataUrl.slice(at + marker.length);
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}

/** Read a Blob as its base64 payload (no data-URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(dataUrlToBase64(String(fr.result)));
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}
