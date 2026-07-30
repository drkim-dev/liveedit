import { App, PluginSettingTab, Setting } from "obsidian";
import type LiveEditPlugin from "./main";

export interface LiveEditSettings {
  serverUrl: string;
  room: string;
  displayName: string;
  color: string;
  sharedFolder: string;
  autoReconnect: boolean;
}

const PALETTE = ["#e64980", "#f08c00", "#37b24d", "#1c7ed6", "#7048e8", "#0ca678"];

export function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

export const DEFAULT_SETTINGS: LiveEditSettings = {
  serverUrl: "ws://localhost:1234",
  room: "team",
  displayName: "",
  color: randomColor(),
  sharedFolder: "",
  autoReconnect: true,
};

export class LiveEditSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LiveEditPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "연결" });

    new Setting(containerEl)
      .setName("릴레이 서버 주소")
      .setDesc("팀에서 운영 중인 LiveEdit 릴레이 서버 주소 (예: ws://192.168.0.10:1234)")
      .addText((text) =>
        text
          .setPlaceholder("ws://192.168.0.10:1234")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("방 코드")
      .setDesc("같은 코드를 쓰는 사람끼리만 같은 문서를 공유합니다.")
      .addText((text) =>
        text
          .setPlaceholder("team")
          .setValue(this.plugin.settings.room)
          .onChange(async (value) => {
            this.plugin.settings.room = value.trim() || DEFAULT_SETTINGS.room;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("자동 재연결")
      .setDesc("연결이 끊기면 자동으로 재시도합니다.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoReconnect).onChange(async (value) => {
          this.plugin.settings.autoReconnect = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "표시" });

    new Setting(containerEl)
      .setName("표시 이름")
      .setDesc("팀원들에게 보여질 이름")
      .addText((text) =>
        text
          .setPlaceholder("이름")
          .setValue(this.plugin.settings.displayName)
          .onChange(async (value) => {
            this.plugin.settings.displayName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("커서 색상")
      .setDesc("내 커서와 참여자 목록에 표시되는 색상")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.color).onChange(async (value) => {
          this.plugin.settings.color = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "동기화 범위" });

    new Setting(containerEl)
      .setName("공유 폴더")
      .setDesc("비워두면 vault 전체를 공유합니다. 특정 폴더만 공유하려면 경로를 입력하세요 (예: Team).")
      .addText((text) =>
        text
          .setPlaceholder("전체 vault")
          .setValue(this.plugin.settings.sharedFolder)
          .onChange(async (value) => {
            this.plugin.settings.sharedFolder = value.trim().replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          }),
      );
  }
}
