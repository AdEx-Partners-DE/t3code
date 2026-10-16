// The checklist overview lives in the sidebar's state; the command palette opens it through this event.
const OPEN_PORTFOLIO_CHECKLISTS_EVENT = "t3code:open-portfolio-checklists";

export function openPortfolioChecklists(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PORTFOLIO_CHECKLISTS_EVENT));
}

export function onOpenPortfolioChecklists(listener: () => void): () => void {
  window.addEventListener(OPEN_PORTFOLIO_CHECKLISTS_EVENT, listener);
  return () => window.removeEventListener(OPEN_PORTFOLIO_CHECKLISTS_EVENT, listener);
}
