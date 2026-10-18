// The checklist and open-question overviews live in the sidebar's state; the command palette opens them through these events.
const OPEN_PORTFOLIO_CHECKLISTS_EVENT = "t3code:open-portfolio-checklists";
const OPEN_PENDING_REQUESTS_EVENT = "t3code:open-pending-requests";

export function openPortfolioChecklists(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PORTFOLIO_CHECKLISTS_EVENT));
}

export function onOpenPortfolioChecklists(listener: () => void): () => void {
  window.addEventListener(OPEN_PORTFOLIO_CHECKLISTS_EVENT, listener);
  return () => window.removeEventListener(OPEN_PORTFOLIO_CHECKLISTS_EVENT, listener);
}

export function openPendingRequests(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PENDING_REQUESTS_EVENT));
}

export function onOpenPendingRequests(listener: () => void): () => void {
  window.addEventListener(OPEN_PENDING_REQUESTS_EVENT, listener);
  return () => window.removeEventListener(OPEN_PENDING_REQUESTS_EVENT, listener);
}
