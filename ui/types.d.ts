declare module "blessed" {
  const blessed: any;
  export namespace Widgets {
    type BoxElement = any;
    type ListElement = any;
    type Screen = any;
    type TextboxElement = any;
    type BlessedElement = any;
  }
  export default blessed;
}

declare namespace blessed {
  namespace Widgets {
    type BoxElement = any;
    type ListElement = any;
    type Screen = any;
    type TextboxElement = any;
    type BlessedElement = any;
  }
}

declare module "playwright" {
  export type Page = any;
  export type WebSocket = any;
  export const chromium: any;
}
