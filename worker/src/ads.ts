// Свободные рекламные места на страницах тулз: тематический слот «здесь может быть ваша реклама»
import ads from "../../data/adslots.json";
import { h } from "./util";

type SlotId = keyof typeof ads.slots;

export function adSlot(slot: SlotId = "general"): string {
  const s = ads.slots[slot] ?? ads.slots.general;
  return `<aside class="adslot adslot-wide" aria-label="Свободное рекламное место"><a href="${h(ads.contact.url)}" rel="noopener">` +
    `<span class="adslot-k">Здесь может быть ваша реклама</span><span class="adslot-t">${h(s.title)}</span>` +
    `<span class="adslot-p">${h(s.pitch)}</span><span class="adslot-w">${h(s.who)}</span>` +
    `<span class="adslot-c"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.9 4.6 18.7 19.7c-.2 1-.9 1.3-1.8.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2l-11 6.9-4.7-1.5c-1-.3-1-1 .2-1.5L20.5 3.6c.9-.3 1.6.2 1.4 1Z"/></svg>Написать ${h(ads.contact.label)}</span></a></aside>`;
}

export const adContact = ads.contact;
export type { SlotId };
