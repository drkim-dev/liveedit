import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type LiveEditPlugin from "./main";

export type Role = "host" | "member";

export interface LiveEditSettings {
  role: Role;
  hostToken: string;
  serverUrl: string;
  room: string;
  displayName: string;
  color: string;
  /** Legacy migration marker only; 0.5.2 always shares this vault. */
  sharedFolder: string;
  autoReconnect: boolean;
}

const PALETTE = ["#e64980", "#f08c00", "#37b24d", "#1c7ed6", "#7048e8", "#0ca678"];

export function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

export const DEFAULT_SETTINGS: LiveEditSettings = {
  role: "member",
  hostToken: "",
  serverUrl: "ws://localhost:1234",
  room: "team",
  displayName: "",
  color: randomColor(),
  sharedFolder: "",
  autoReconnect: true,
};

export class LiveEditSettingTab extends PluginSettingTab {
  private unsubscribeConnection: (() => void) | null = null;
  private everConnected = false;
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
    this.unsubscribeConnection?.();
    const { containerEl } = this;
    containerEl.empty();
    const isHost = this.plugin.settings.role === "host";

    containerEl.createEl("h3", { text: "역할" });

    new Setting(containerEl)
      .setName("이 PC의 역할")
      .setDesc(
        isHost
          ? "이 PC에서 서버를 실행하고 아래 방 개설하기를 누르면 시작합니다. 현재 볼트의 노트를 공유합니다."
          : "참여자: 방장이 켜둔 릴레이 서버 주소로 접속만 하면 됩니다. 별도로 서버를 실행할 필요가 없습니다.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("member", "참여자")
          .addOption("host", "방장")
          .setValue(this.plugin.settings.role)
          .onChange(async (value) => {
            this.plugin.settings.role = value as Role;
            await this.plugin.saveSettings();
            this.disconnectIfLive("역할");
            this.display(); // redraw — labels/hints below depend on the role
          }),
      );

    containerEl.createEl("h3", { text: "연결" });

    let connectButton: ButtonComponent;
    let disconnectButton: ButtonComponent;
    let connectionSetting: Setting;
    const connectionDescription = "이 볼트의 노트를 함께 편집합니다. 최신 동기화가 끝나면 편집할 수 있습니다.";
    const updateButtons = (): void => {
      const status = this.plugin.getConnectionStatus();
      connectionSetting?.setDesc(this.plugin.getConnectionMessage?.() || connectionDescription);
      if (status === "connected") this.everConnected = true;
      connectButton.setButtonText(status === "syncing" ? "최신 문서 받는 중…" : status === "connecting" ? (isHost ? "방 여는 중…" : "연결 중…") : isHost ? (status === "connected" ? "방 열림" : "방 개설하기") : this.everConnected || this.plugin.isConnected() ? "재접속" : "참여하기");
      connectButton.setDisabled(status === "connecting" || status === "syncing" || (isHost && status === "connected"));
      disconnectButton.setDisabled(!this.plugin.isConnected());
    };
    connectionSetting = new Setting(containerEl)
      .setName(isHost ? "방 개설" : "방 참여")
      .setDesc(connectionDescription)
      .addButton((button) => {
        connectButton = button;
        button.setCta().onClick(async () => {
          button.setDisabled(true);
          try { await this.plugin.reconnect(); } finally { updateButtons(); }
        });
      })
      .addButton((button) => {
        disconnectButton = button;
        button.setButtonText(isHost ? "방 닫기" : "연결 해제").onClick(() => this.plugin.disconnect());
      });
    updateButtons();
    this.unsubscribeConnection = this.plugin.onConnectionChange(updateButtons);

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
      .setName("자동 재연결")
      .setDesc("연결이 끊기면 다시 접속합니다. 방장은 Obsidian 시작 후 방 개설하기를 직접 눌러야 합니다.")
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

  }

  hide(): void {
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
  }
}
