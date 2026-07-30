import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LiveEditPlugin from "./main";

export type Role = "host" | "member";

export interface LiveEditSettings {
  role: Role;
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
  role: "member",
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

  /**
   * Server address / room code only take effect on the next connect() — an
   * already-open session keeps using whatever it connected with. Silently
   * continuing on the old room after the user thinks they changed it is
   * exactly how two people can end up "in the same room" without noticing.
   * So: force a disconnect immediately and make that unmissable.
   */
  private disconnectIfLive(fieldLabel: string): void {
    if (!this.plugin.isConnected()) return;
    this.plugin.disconnect();
    new Notice(
      `LiveEdit: ${fieldLabel}가 변경되어 연결을 끊었습니다. 확인 후 '세션 연결'로 다시 접속해주세요.`,
      8000,
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const isHost = this.plugin.settings.role === "host";

    containerEl.createEl("h3", { text: "역할" });

    new Setting(containerEl)
      .setName("이 PC의 역할")
      .setDesc(
        isHost
          ? "방장: server/ 폴더의 릴레이 서버를 이 PC(또는 팀 상시 서버)에서 계속 켜두고, Obsidian도 함께 켜둔 상태로 팀원과 같이 편집합니다."
          : "참여자: 방장이 켜둔 릴레이 서버 주소로 접속만 하면 됩니다. 별도로 서버를 실행할 필요가 없습니다.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("member", "참여자")
          .addOption("host", "방장 (릴레이 서버 운영)")
          .setValue(this.plugin.settings.role)
          .onChange(async (value) => {
            this.plugin.settings.role = value as Role;
            await this.plugin.saveSettings();
            this.display(); // redraw — labels/hints below depend on the role
          }),
      );

    containerEl.createEl("h3", { text: "연결" });

    const serverSetting = new Setting(containerEl)
      .setName("릴레이 서버 주소")
      .setDesc(
        isHost
          ? "이 PC에서 실행 중인 서버 주소. 보통 ws://localhost:포트. 팀원에게는 이 PC의 사설망 IP(예: ws://192.168.0.10:포트)를 알려주세요."
          : "방장에게 전달받은 서버 주소를 입력하세요 (예: ws://192.168.0.10:1234)",
      )
      .addText((text) =>
        text
          .setPlaceholder(isHost ? "ws://localhost:1234" : "ws://192.168.0.10:1234")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
            this.disconnectIfLive("서버 주소");
          }),
      );
    if (isHost) {
      serverSetting.addButton((button) =>
        button
          .setButtonText("서버 상태 확인")
          .onClick(() => this.plugin.checkServerHealth()),
      );
    }

    new Setting(containerEl)
      .setName("방 코드")
      .setDesc(
        isHost
          ? "팀원에게 서버 주소와 함께 알려줄 코드. 같은 코드를 쓰는 사람끼리만 같은 문서를 공유합니다."
          : "같은 코드를 쓰는 사람끼리만 같은 문서를 공유합니다. 방장에게 확인하세요.",
      )
      .addText((text) =>
        text
          .setPlaceholder("team")
          .setValue(this.plugin.settings.room)
          .onChange(async (value) => {
            this.plugin.settings.room = value.trim() || DEFAULT_SETTINGS.room;
            await this.plugin.saveSettings();
            this.disconnectIfLive("방 코드");
          }),
      );

    new Setting(containerEl)
      .setName("자동 재연결")
      .setDesc("연결이 끊기면 자동으로 재시도하고, Obsidian을 켤 때 자동으로 접속합니다.")
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
