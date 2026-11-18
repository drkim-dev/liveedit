export class TAbstractFile { constructor(public path: string) {} }
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Notice { constructor(_message: string) {} }
export class Plugin {
  constructor(public app: any) {}
  async saveData(_value: unknown): Promise<void> {}
}
export class MarkdownView {
  constructor(public file: TFile | null, public editor: any) {}
}
export class Modal { constructor(public app: any) {} }
export class PluginSettingTab {
  containerEl: any = { empty() {}, createEl() {} };
  constructor(public app: any, public plugin: any) {}
}
export class ButtonComponent {
  text = "";
  disabled = false;
  callback: (() => unknown) | null = null;
  setButtonText(value: string): this { this.text = value; return this; }
  setDisabled(value: boolean): this { this.disabled = value; return this; }
  setCta(): this { return this; }
  onClick(callback: () => unknown): this { this.callback = callback; return this; }
}
class Control {
  inputEl = { type: "" };
  setValue(_value: unknown): this { return this; }
  setPlaceholder(_value: string): this { return this; }
  addOption(_value: string, _label: string): this { return this; }
  onChange(_callback: unknown): this { return this; }
}
export class Setting {
  static buttons: ButtonComponent[] = [];
  constructor(_container: unknown) {}
  setName(_value: string): this { return this; }
  setDesc(_value: string): this { return this; }
  addButton(callback: (button: ButtonComponent) => void): this {
    const button = new ButtonComponent(); Setting.buttons.push(button); callback(button); return this;
  }
  addText(callback: (control: Control) => void): this { callback(new Control()); return this; }
  addDropdown(callback: (control: Control) => void): this { callback(new Control()); return this; }
  addToggle(callback: (control: Control) => void): this { callback(new Control()); return this; }
  addColorPicker(callback: (control: Control) => void): this { callback(new Control()); return this; }
}
import { StateEffect, StateField } from "@codemirror/state";
export const setEditorFile = StateEffect.define<{ file: { path: string } | null }>();
export const editorInfoField = StateField.define({
  create: () => ({ file: null as { path: string } | null }),
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setEditorFile)) value = effect.value;
    return value;
  },
});
