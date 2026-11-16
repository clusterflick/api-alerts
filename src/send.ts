import type { Digest } from "./digest";

/**
 * Sending an alert, through Cloudflare Email Service's binding (`EMAIL`),
 * from the one address the binding allows, with replies going to an address
 * that's read (`REPLY_TO`).
 */

export const FROM = {
  email: "alert@alerts.clusterflick.com",
  name: "Clusterflick Alerts",
};

/**
 * Sends the digest, and gives the message's id. Throws if Email Service
 * refuses it, with the reason it gave: nothing was sent.
 */
export async function sendDigest(
  env: Pick<Env, "EMAIL" | "REPLY_TO">,
  to: string,
  digest: Digest,
  headers: Record<string, string> = {},
): Promise<string> {
  const { messageId } = await env.EMAIL.send({
    from: FROM,
    to,
    replyTo: env.REPLY_TO,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
    headers,
  });
  return messageId;
}
