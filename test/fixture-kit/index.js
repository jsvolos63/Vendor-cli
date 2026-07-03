// @jfs/fixture-kit — exercises every export form runVendorCli must derive:
// function / async function / const / class declarations plus an aggregate
// alias export. Body statements reference globalThis the way real kits do.
export function greet(name) {
  return `hello ${name}`;
}

export async function fetchThing(url) {
  return `fetched ${url}`;
}

export const ANSWER = 42;

export class Widget {
  constructor(id) {
    this.id = id;
  }
}

function internalHelper(x) {
  return x * 2;
}

const hasDom = typeof globalThis.document !== 'undefined';

export function doubled(x) {
  return internalHelper(x) + (hasDom ? 0 : 0);
}

export { internalHelper as helperAlias, ANSWER as THE_ANSWER };
