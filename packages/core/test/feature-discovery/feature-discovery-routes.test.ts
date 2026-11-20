import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverFeatures } from "../../src/index.js";

async function withRouteFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-feature-routes-"));
  try {
    await mkdir(path.join(dir, "src", "pages"), { recursive: true });
    await mkdir(path.join(dir, "src", "components"), { recursive: true });
    await mkdir(path.join(dir, "api-server", "src", "routes"), { recursive: true });

    await writeFile(
      path.join(dir, "src", "App.tsx"),
      [
        'import { Route, Switch } from "wouter";',
        'import { Pricing } from "./pages/Pricing";',
        'import { Settings } from "./pages/Settings";',
        "export function App() {",
        "  return (",
        "    <Switch>",
        '      <Route path="/pricing"><Pricing /></Route>',
        '      <ProtectedRoute><Route path="/settings"><Settings /></Route></ProtectedRoute>',
        "    </Switch>",
        "  );",
        "}",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(dir, "src", "pages", "Pricing.tsx"),
      [
        'import { PricingCard } from "../components/PricingCard";',
        "export function Pricing() {",
        "  return (",
        "    <main>",
        '      <Label htmlFor="seats">Developer seats</Label>',
        '      <Input id="seats" type="number" placeholder="Seats" required />',
        '      <Switch aria-label="Annual billing" />',
        '      <Slider aria-label="Team size" />',
        '      <TabsTrigger value="overview">Overview</TabsTrigger>',
        '      <AccordionTrigger>Is annual billing cheaper?</AccordionTrigger>',
        '      <Select name="region"><option value="">Choose…</option><option value="eu">EU</option><option value="us">US</option></Select>',
        "      <PricingCard />",
        "    </main>",
        "  );",
        "}",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(dir, "src", "components", "PricingCard.tsx"),
      [
        "export function PricingCard() {",
        '  return <button data-testid="choose-pro">Choose Pro</button>;',
        "}",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(dir, "src", "pages", "Settings.tsx"),
      [
        "export function Settings() {",
        '  return <button>Save settings</button>;',
        "}",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(dir, "api-server", "src", "routes", "billing.ts"),
      [
        'app.get("/api/billing", handler);',
        'router.post("/api/checkout", handler);',
        'router.get("/active-run", handler);',
      ].join("\n"),
      "utf8",
    );

    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("route-mapped source feature discovery", () => {
  it("maps Route children and child components to their frontend route", async () => {
    await withRouteFixture(async (dir) => {
      const inventory = discoverFeatures(dir);
      const byLabel = (label: string) => inventory.features.filter((f) => f.label === label);

      const annual = byLabel("Annual billing")[0];
      expect(annual?.kind).toBe("toggle");
      expect(annual?.route_hint).toBe("/pricing");
      expect(annual?.routes).toContain("/pricing");

      const seats = byLabel("Developer seats")[0];
      expect(seats?.kind).toBe("input");
      expect(seats?.input_type).toBe("number");
      expect(seats?.required).toBe(true);
      expect(seats?.route_hint).toBe("/pricing");

      // Child component two hops away inherits the parent route.
      const choosePro = byLabel("Choose Pro")[0];
      expect(choosePro?.kind).toBe("button");
      expect(choosePro?.route_hint).toBe("/pricing");
    });
  });

  it("extracts modern UI controls with usable labels and non-placeholder options", async () => {
    await withRouteFixture(async (dir) => {
      const inventory = discoverFeatures(dir);
      const kinds = new Set(inventory.features.map((f) => f.kind));
      for (const kind of ["toggle", "slider", "tab", "accordion", "select", "input", "button"]) {
        expect(kinds.has(kind as never)).toBe(true);
      }

      const select = inventory.features.find((f) => f.kind === "select" && f.label === "region");
      expect(select?.option_hint).toBe("EU");

      const slider = inventory.features.find((f) => f.kind === "slider");
      expect(slider?.label).toBe("Team size");

      const tab = inventory.features.find((f) => f.kind === "tab");
      expect(tab?.label).toBe("Overview");

      const accordion = inventory.features.find((f) => f.kind === "accordion");
      expect(accordion?.label).toContain("annual billing");
    });
  });

  it("marks auth-guarded routes and excludes backend API routes from browser routes", async () => {
    await withRouteFixture(async (dir) => {
      const inventory = discoverFeatures(dir);
      const routes = inventory.features.filter((f) => f.kind === "route");
      const labels = routes.map((f) => f.label);

      expect(labels).toContain("/pricing");
      expect(labels).toContain("/settings");
      expect(labels.some((l) => l.startsWith("/api/"))).toBe(false);
      expect(labels).not.toContain("/active-run");

      const settings = routes.find((f) => f.label === "/settings");
      expect(settings?.auth_required).toBe(true);
      const pricing = routes.find((f) => f.label === "/pricing");
      expect(pricing?.auth_required).toBeFalsy();
    });
  });

  it("derives canonical routes from examples.csv and scopes snapshot controls to their page", async () => {
    await withRouteFixture(async (dir) => {
      await mkdir(path.join(dir, "spec", "contract", "snapshots"), { recursive: true });
      await writeFile(
        path.join(dir, "examples.csv"),
        [
          "title,url_path,notes,description",
          "Autocomplete,/autocomplete,,Search with suggestions",
          "Custom Dropdown,/custom_dropdown,,ARIA dropdown",
          "JQuery UI Menus,/jqueryui/menu,,Nested menu",
          "Basic Auth,/basic_auth,user and pass: admin,Browser auth prompt",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(dir, "spec", "contract", "snapshots", "autocomplete.html"),
        '<input id="autocomplete" type="text" placeholder="Type a fruit" />',
        "utf8",
      );
      await writeFile(
        path.join(dir, "spec", "contract", "snapshots", "custom_dropdown.html"),
        '<div id="fruit-combo" role="combobox" aria-label="Fruit combo">Fruit combo</div>',
        "utf8",
      );
      await writeFile(
        path.join(dir, "spec", "contract", "snapshots", "jqueryui_menu.html"),
        '<button id="menu-item">Item one</button>',
        "utf8",
      );

      const inventory = discoverFeatures(dir);
      const routes = inventory.features.filter((f) => f.kind === "route").map((f) => f.label);
      expect(routes).toEqual(expect.arrayContaining(["/autocomplete", "/custom_dropdown", "/jqueryui/menu", "/basic_auth"]));

      const autocomplete = inventory.features.find((f) => f.selector_hint === "#autocomplete");
      expect(autocomplete?.route_hint).toBe("/autocomplete");
      const fruitCombo = inventory.features.find((f) => f.selector_hint === "#fruit-combo");
      expect(fruitCombo?.route_hint).toBe("/custom_dropdown");
      const menuItem = inventory.features.find((f) => f.selector_hint === "#menu-item");
      expect(menuItem?.route_hint).toBe("/jqueryui/menu");

      expect(inventory.features.some((f) => JSON.stringify(f).includes("user and pass"))).toBe(false);
      expect(inventory.features.find((f) => f.label === "/basic_auth")?.auth_required).toBe(true);
    });
  });

  it("scopes server-rendered catalog and alias views to their owner routes", async () => {
    await withRouteFixture(async (dir) => {
      await mkdir(path.join(dir, "views"), { recursive: true });
      await writeFile(
        path.join(dir, "examples.csv"),
        ["title,url_path,notes", "Autocomplete,/autocomplete,", "Upload,/upload,", "Two-Factor,/two_factor,"].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(dir, "views", "examples.erb"),
        '<a href="/autocomplete">Autocomplete</a><a href="/upload">File Upload</a>',
        "utf8",
      );
      await writeFile(
        path.join(dir, "views", "two_factor_code.erb"),
        '<form id="two-factor-code"><button type="submit">Verify</button></form>',
        "utf8",
      );
      await writeFile(
        path.join(dir, "views", "upload_error.erb"),
        '<a href="/upload">Back to the File Uploader</a>',
        "utf8",
      );
      await writeFile(
        path.join(dir, "server.rb"),
        '<a href="/about/">About</a>',
        "utf8",
      );

      const inventory = discoverFeatures(dir);
      const catalogLink = inventory.features.find((f) => f.label === "Autocomplete" && f.source.path === "views/examples.erb");
      expect(catalogLink?.route_hint).toBe("/autocomplete");
      expect(catalogLink?.routes).toEqual(["/"]);

      const verify = inventory.features.find((f) => f.label === "Verify");
      expect(verify?.routes).toEqual(["/two_factor"]);

      const backLink = inventory.features.find((f) => f.label === "Back to the File Uploader");
      expect(backLink?.routes).toEqual(["/upload"]);

      expect(inventory.features.some((f) => f.source.path === "server.rb")).toBe(false);
    });
  });
});
