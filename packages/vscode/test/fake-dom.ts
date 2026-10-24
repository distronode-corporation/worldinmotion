// A tiny DOM for the webview renderer's tests: elements with attributes, text, children and
// listeners. It has no innerHTML at all, so a renderer that reached for one would fail here.

import type { Doc, El, Listener } from "../src/webview/render.ts";

export class FakeEl implements El {
  readonly tag: string;
  readonly ns: string | undefined;
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  readonly listeners = new Map<string, Listener[]>();
  private text: string | null = null;

  constructor(tag: string, ns?: string) {
    this.tag = tag;
    this.ns = ns;
  }

  get textContent(): string | null {
    return this.children.length > 0 ? this.children.map((c) => c.textContent ?? "").join("") : this.text;
  }
  set textContent(v: string | null) {
    this.children.length = 0;
    this.text = v;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(child: El): El {
    this.children.push(child as FakeEl);
    return child;
  }
  replaceChildren(...children: El[]): void {
    this.children.length = 0;
    this.children.push(...(children as FakeEl[]));
  }
  addEventListener(type: "click" | "keydown", fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  /** Plays an event; returns whether a listener called preventDefault. */
  dispatch(type: "click" | "keydown", key?: string): boolean {
    let prevented = false;
    for (const fn of this.listeners.get(type) ?? []) fn({ ...(key === undefined ? {} : { key }), preventDefault: () => (prevented = true) });
    return prevented;
  }

  /** Every element below this one, depth first. */
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }

  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return this.all().filter(pred);
  }
}

export class FakeDoc implements Doc {
  readonly byId = new Map<string, FakeEl>();
  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }
  createElementNS(ns: string, tag: string): FakeEl {
    return new FakeEl(tag, ns);
  }
  getElementById(id: string): FakeEl | null {
    return this.byId.get(id) ?? null;
  }
}
