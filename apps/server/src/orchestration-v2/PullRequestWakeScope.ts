import type { OrchestrationV2Notification } from "@t3tools/contracts";

/**
 * Whether a waiting pull request wake reports on this one pull request and no other. Wakes that
 * joined a waiting one (rank 0ca) list each pull request in the summary as `#N: …`, joined by
 * `; `, and name each pull request's URL in the text, so both must point at this one.
 */
export function wakeConcernsOnly(
  message: {
    readonly text: string;
    readonly notification?: OrchestrationV2Notification | undefined;
  },
  number: number,
  url: string,
): boolean {
  const summary = message.notification?.summary;
  if (summary === undefined || !message.text.includes(url)) return false;
  const numbers = summary.split("; ").map((part) => /^#(\d+):/.exec(part)?.[1]);
  return numbers.every((found) => found !== undefined && Number(found) === number);
}
