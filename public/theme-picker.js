export const PALETTES = [
  { id: "linen", name: "Linen", description: "Warm ivory and terracotta" },
  { id: "ocean", name: "Ocean", description: "Quiet blue and sea glass" },
  { id: "forest", name: "Forest", description: "Botanical green and moss" },
  { id: "ink", name: "Ink", description: "Crisp neutral contrast" },
];

export function renderThemePicker(container, currentPalette = "linen", onSelect = () => {}) {
  if (!container || typeof container.replaceChildren !== "function") {
    throw new TypeError("renderThemePicker requires a DOM container");
  }

  const root = document.createElement("div");
  root.className = "theme-picker";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Color palette");

  const heading = document.createElement("h4");
  heading.className = "theme-picker-heading";
  heading.textContent = "Choose a palette";

  const grid = document.createElement("div");
  grid.className = "theme-picker-grid";

  for (const palette of PALETTES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-picker-card";
    button.dataset.palette = palette.id;
    button.setAttribute("aria-pressed", String(palette.id === currentPalette));
    button.setAttribute("aria-label", `${palette.name}: ${palette.description}`);

    const preview = document.createElement("span");
    preview.className = "theme-picker-preview";
    preview.setAttribute("aria-hidden", "true");
    for (const color of ["panel", "accent", "ink", "olive"]) {
      const swatch = document.createElement("span");
      swatch.className = `preview-${color}`;
      preview.append(swatch);
    }

    const copy = document.createElement("span");
    copy.className = "theme-picker-copy";
    const name = document.createElement("span");
    name.className = "theme-picker-name";
    name.textContent = palette.name;
    const description = document.createElement("span");
    description.className = "theme-picker-description";
    description.textContent = palette.description;
    copy.append(name, description);

    const selected = document.createElement("span");
    selected.className = "theme-picker-selected";
    selected.textContent = "Selected";
    selected.hidden = palette.id !== currentPalette;

    button.append(preview, copy, selected);
    button.addEventListener("click", () => {
      for (const card of grid.querySelectorAll(".theme-picker-card")) {
        const active = card === button;
        card.setAttribute("aria-pressed", String(active));
        card.querySelector(".theme-picker-selected").hidden = !active;
      }
      onSelect(palette.id);
    });
    grid.append(button);
  }

  root.append(heading, grid);
  container.replaceChildren(root);
}
