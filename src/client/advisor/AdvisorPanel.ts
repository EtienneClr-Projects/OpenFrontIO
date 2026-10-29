import { Structures } from "@openfront/engine-api/game/GameTypes";
import { css, html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { translateText } from "../Utils";
import type { AdvisorResult, Recommendation } from "./Types";

@customElement("strategy-advisor")
export class AdvisorPanel extends LitElement {
  @state() enabled = false;
  @state() status = "disabled";
  @state() queryState = "checking";
  @state() canAutomate = false;
  @state() automatic = false;
  @state() automaticState = "off";
  @state() result: AdvisorResult = { context: "opening", items: [] };
  @state() private expanded = false;
  @state() private collapsed = false;
  onToggle: (enabled: boolean) => void = () => {};
  onHide: (id: string, snooze: boolean) => void = () => {};
  onFocus: (tile: number) => void = () => {};
  onAutomatic: (enabled: boolean) => void = () => {};
  diagnostics: () => { samples: number; p95Ms: number } = () => ({
    samples: 0,
    p95Ms: 0,
  });

  static styles = css`
    :host {
      position: fixed;
      left: 12px;
      bottom: 12px;
      z-index: 50;
      width: min(330px, calc(100vw - 24px));
      color: #eee;
      font:
        13px/1.45 system-ui,
        sans-serif;
      pointer-events: auto;
    }
    section {
      background: #131c29f2;
      border: 1px solid #65758c;
      border-radius: 10px;
      padding: 12px;
      max-height: min(65vh, 640px);
      overflow: auto;
    }
    .overview {
      display: grid;
      gap: 8px;
      margin: 10px 0;
    }
    .phase,
    .posture {
      border-radius: 7px;
      padding: 9px 10px;
    }
    .phase {
      background: #202e40;
      border: 1px solid #526985;
    }
    .phase-label,
    .action-label {
      display: block;
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0.08em;
    }
    .phase-name {
      display: block;
      margin-top: 2px;
      font-size: 15px;
      line-height: 1.25;
    }
    .phase p,
    .posture p {
      margin: 5px 0 0;
    }
    .posture {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 3px 10px;
      border: 1px solid;
    }
    .posture[data-action="push"] {
      background: #173a32;
      border-color: #52b894;
    }
    .posture[data-action="retain"] {
      background: #3b3020;
      border-color: #d3a64b;
    }
    .action-label {
      grid-row: span 2;
      font-size: 16px;
    }
    header,
    nav {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    header strong {
      flex: 1;
    }
    article {
      border-top: 1px solid #455365;
      margin-top: 10px;
      padding-top: 8px;
    }
    article[data-urgent] {
      border-left: 3px solid #f6a34b;
      padding-left: 8px;
    }
    p {
      margin: 6px 0;
    }
    small {
      color: #b5c7dc;
    }
    button {
      background: #30445e;
      color: white;
      border: 1px solid #7085a0;
      border-radius: 4px;
      padding: 4px 7px;
      cursor: pointer;
      font: inherit;
    }
    button:focus-visible,
    summary:focus-visible {
      outline: 2px solid #f6cf64;
    }
    summary {
      cursor: pointer;
    }
    @media (max-width: 700px) {
      section {
        max-height: 45vh;
      }
    }
  `;

  private text(key: string, params?: Record<string, string | number>) {
    return translateText(`advisor.${key}`, params);
  }

  private get action(): "push" | "retain" {
    const defensiveRules = new Set([
      "defense",
      "exposure",
      "landing",
      "nuke",
      "clock",
      "strong_neighbor",
      "traitor",
    ]);
    if (
      this.result.context === "contested" ||
      this.result.context === "nuclear" ||
      this.result.context === "endgame" ||
      this.result.items.some((item) => defensiveRules.has(item.rule))
    ) {
      return "retain";
    }
    return this.queryState === "ready" &&
      this.result.items.some((item) =>
        ["neutral", "weak_neighbor", "reclaim"].includes(item.rule),
      )
      ? "push"
      : "retain";
  }

  private item(item: Recommendation) {
    const params = {
      ...item.params,
      stage:
        typeof item.params.stage === "string"
          ? this.text(`stage_${item.params.stage}`)
          : "",
      eta:
        item.params.eta === "unknown"
          ? this.text("unknown")
          : String(item.params.eta ?? ""),
      coverage:
        typeof item.params.coverage === "string"
          ? this.text(`coverage_${item.params.coverage}`, item.params)
          : "",
      infrastructure:
        Structures.types
          .filter((type) => Number(item.params[type] ?? 0) > 0)
          .map(
            (type) =>
              `${translateText(`unit_type.${type.toLowerCase().replace(/ /g, "_")}`)}: ${item.params[type]}`,
          )
          .join(", ") || this.text("no_infrastructure"),
    };
    return html`
      <article ?data-urgent=${item.priority >= 90}>
        <strong>${this.text(`${item.rule}_title`, params)}</strong>
        <p>
          <small
            >${this.text(item.confidence)} ·
            ${this.text("tick", { tick: item.lastTick })}</small
          >
        </p>
        ${
          item.rule === "nuke"
            ? html`
                <p>${params.coverage}</p>
                <p>${this.text("nuke_assets", params)}</p>
              `
            : nothing
        }
        <details>
          <summary>${this.text("why")}</summary>
          <p>${this.text(`${item.rule}_detail`, params)}</p>
          <p><small>${this.text("heuristic")}</small></p>
        </details>
        <nav>
          ${
            item.tile !== undefined
              ? html`<button @click=${() => this.onFocus(item.tile!)}>
                  ${this.text("focus")}
                </button>`
              : nothing
          }
          <button @click=${() => this.onHide(item.id, true)}>
            ${this.text("snooze")}
          </button>
          <button @click=${() => this.onHide(item.id, false)}>
            ${this.text("dismiss")}
          </button>
        </nav>
      </article>
    `;
  }

  render() {
    const items = this.result.items;
    const action = this.action;
    return html`
      <section aria-label=${this.text("title")}>
        <header>
          <strong>${this.text("title")}</strong>
          <button
            aria-expanded=${!this.collapsed}
            @click=${() => {
              this.collapsed = !this.collapsed;
            }}
          >
            ${this.text(this.collapsed ? "expand" : "collapse")}
          </button>
        </header>
        ${
          this.collapsed
            ? nothing
            : html`
                ${
                  this.enabled && this.status === "active"
                    ? html`
                        <div class="overview" aria-live="polite">
                          <div class="phase">
                            <span class="phase-label"
                              >${this.text("phase_label")}</span
                            >
                            <strong class="phase-name">
                              ${this.text(`context_${this.result.context}`)}
                            </strong>
                            <p>
                              <small
                                >${this.text(`phase_${this.result.context}_detail`)}</small
                              >
                            </p>
                          </div>
                          <div class="posture" data-action=${action}>
                            <strong class="action-label">
                              ${this.text(`action_${action}`)}
                            </strong>
                            <span>${this.text(`action_${action}_detail`)}</span>
                          </div>
                        </div>
                      `
                    : nothing
                }
                <p><small>${this.text("read_only")}</small></p>
                <label>
                  <input
                    type="checkbox"
                    .checked=${this.enabled}
                    @change=${(event: Event) => {
                      const input = event.currentTarget;
                      if (!(input instanceof HTMLInputElement)) return;
                      this.onToggle(input.checked);
                    }}
                  />
                  ${this.text("enable")}
                </label>
                ${
                  this.canAutomate
                    ? html`
                        <p>
                          <label>
                            <input
                              type="checkbox"
                              .checked=${this.automatic}
                              @change=${(event: Event) => {
                                const input = event.currentTarget;
                                if (input instanceof HTMLInputElement)
                                  this.onAutomatic(input.checked);
                              }}
                            />
                            ${this.text("automatic")}
                          </label>
                        </p>
                        <p><small>${this.text("automatic_warning")}</small></p>
                        <p role="status">
                          ${this.text(`automatic_${this.automaticState}`)}
                        </p>
                      `
                    : nothing
                }
                <p role="status">${this.text(`status_${this.status}`)}</p>
                ${
                  this.enabled && this.status === "active"
                    ? html`
                        ${
                          this.queryState !== "ready"
                            ? html`<p>
                                <small
                                  >${this.text(`query_${this.queryState}`)}</small
                                >
                              </p>`
                            : nothing
                        }
                        ${items.length === 0 ? html`<p>${this.text("no_advice")}</p>` : nothing}
                        ${repeat(
                          this.expanded ? items : items.slice(0, 3),
                          (item) => item.id,
                          (item) => this.item(item),
                        )}
                        ${
                          items.length > 3
                            ? html` <button
                                @click=${() => {
                                  this.expanded = !this.expanded;
                                }}
                              >
                                ${this.text(this.expanded ? "less" : "more", { count: items.length - 3 })}
                              </button>`
                            : nothing
                        }
                      `
                    : nothing
                }
              `
        }
      </section>
    `;
  }
}
