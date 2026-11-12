function closeHiddenNavigation(): void {
  for (const trigger of document.querySelectorAll<HTMLButtonElement>(
    ".site-menu-toggle, .docs-menu-toggle",
  )) {
    const menu = trigger.popoverTargetElement;
    if (
      menu instanceof HTMLElement &&
      menu.matches(":popover-open") &&
      getComputedStyle(trigger).display === "none"
    )
      menu.hidePopover();
  }
}
addEventListener("resize", closeHiddenNavigation);
