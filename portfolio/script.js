const root = document.body;
const toggle = document.querySelector("[data-theme-toggle]");
const storageKey = "prem-portfolio-theme";

const applyTheme = (theme) => {
  root.dataset.theme = theme;
  const label = theme === "light" ? "Light" : "Dark";
  toggle?.setAttribute("aria-label", `Switch theme, current ${label}`);
};

const preferredTheme = () => {
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
};

applyTheme(preferredTheme());

toggle?.addEventListener("click", () => {
  const nextTheme = root.dataset.theme === "light" ? "dark" : "light";
  window.localStorage.setItem(storageKey, nextTheme);
  applyTheme(nextTheme);
});
