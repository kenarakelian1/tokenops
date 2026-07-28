; TokenOps Agent — Windows Setup (Inno Setup 6)
; Build after packaging:
;   pnpm package:agent
;   ISCC installer\windows\TokenOpsAgent.iss
;
; Output: dist\TokenOps-Agent-Setup.exe
; Per-user install (no admin / no UAC).

#define MyAppName "TokenOps Agent"
#define MyAppVersion "0.1.1"
#define MyAppPublisher "TokenOps"
#define MyAppURL "https://github.com/kenarakelian1/tokenops"
#define MyDashboard "https://tokenops-web-production.up.railway.app"
#define MyDefaultApi "https://tokenops-api-production.up.railway.app"

#ifndef PayloadDir
  #define PayloadDir "..\..\dist\tokenops-agent-win\payload\agent"
#endif

[Setup]
AppId={{8F3C2A91-6E4B-4D2F-9C11-A1B2C3D4E5F6}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\TokenOps\agent
DefaultGroupName=TokenOps
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=TokenOps-Agent-Setup
SetupIconFile=
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}
CloseApplications=no
RestartIfNeededByRun=no
; Reduces some SmartScreen friction vs random scripts (still unsigned)
InfoBeforeFile=
LicenseFile=

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: checkedonce
Name: "startup"; Description: "Start TokenOps agent when I sign in to Windows"; GroupDescription: "Startup:"; Flags: checkedonce

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\TokenOps Agent"; Filename: "{cmd}"; Parameters: "/k ""{app}\tokenops.cmd"" agent run"; WorkingDir: "{app}"; Comment: "Start TokenOps agent"
Name: "{group}\TokenOps Status"; Filename: "{cmd}"; Parameters: "/k ""{app}\tokenops.cmd"" status"; WorkingDir: "{app}"
Name: "{group}\TokenOps Config"; Filename: "{win}\explorer.exe"; Parameters: """{%USERPROFILE}\.tokenops"""
Name: "{group}\Uninstall TokenOps Agent"; Filename: "{uninstallexe}"
Name: "{autodesktop}\TokenOps Agent"; Filename: "{cmd}"; Parameters: "/k ""{app}\tokenops.cmd"" agent run"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{cmd}"; Parameters: "/c ""{app}\tokenops.cmd"" status & pause"; Description: "Show agent status"; Flags: postinstall skipifsilent unchecked
Filename: "{cmd}"; Parameters: "/k ""{app}\tokenops.cmd"" agent run"; Description: "Start TokenOps agent now"; Flags: postinstall nowait skipifsilent unchecked

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\TokenOps\bin"
Type: files; Name: "{localappdata}\TokenOps\install-manifest.json"
Type: files; Name: "{userdesktop}\Claude Code + TokenOps.cmd"

[Code]
var
  ToolsPage: TInputQueryWizardPage;
  CloudPage: TInputQueryWizardPage;
  KeysPage: TInputQueryWizardPage;
  CheckClaude, CheckCursor, CheckGrok, CheckOpenAI, CheckOther: TNewCheckBox;
  ToolsPanel: TNewStaticText;

function EscapeToml(const S: string): string;
begin
  Result := S;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

function BoolToml(const B: Boolean): string;
begin
  if B then Result := 'true' else Result := 'false';
end;

function NodeExists: Boolean;
var
  R: Integer;
begin
  Result := Exec('node.exe', '-v', '', SW_HIDE, ewWaitUntilTerminated, R) and (R = 0);
end;

function InitializeSetup: Boolean;
var
  R: Integer;
begin
  Randomize;
  Result := True;
  if not NodeExists then
  begin
    if MsgBox(
      'Node.js 22+ was not found on PATH.'#13#10#13#10 +
      'TokenOps Agent needs Node.js to run.'#13#10 +
      'Open nodejs.org to install the LTS build, then run this setup again.'#13#10#13#10 +
      'Open download page now?',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      ShellExec('open', 'https://nodejs.org/', '', '', SW_SHOWNORMAL, ewNoWait, R);
    end;
    Result := False;
  end;
end;

procedure InitializeWizard;
var
  Y: Integer;
begin
  { --- Tools page --- }
  ToolsPage := CreateInputQueryPage(wpWelcome,
    'AI coding tools',
    'Which tools should TokenOps capture?',
    'Select every tool you use. The installer will configure capture for each.');

  { InputQueryPage always creates one edit; hide it and use checkboxes instead }
  ToolsPage.Edits[0].Visible := False;
  ToolsPage.PromptLabels[0].Visible := False;
  try
    ToolsPage.SubCaptionLabel.Visible := False;
  except
  end;

  Y := ScaleY(60);
  CheckClaude := TNewCheckBox.Create(ToolsPage);
  CheckClaude.Parent := ToolsPage.Surface;
  CheckClaude.Left := ScaleX(16);
  CheckClaude.Top := Y;
  CheckClaude.Width := ToolsPage.SurfaceWidth - ScaleX(32);
  CheckClaude.Height := ScaleY(22);
  CheckClaude.Caption := 'Claude Code (OpenTelemetry metrics)';
  CheckClaude.Checked := True;

  Y := Y + ScaleY(28);
  CheckCursor := TNewCheckBox.Create(ToolsPage);
  CheckCursor.Parent := ToolsPage.Surface;
  CheckCursor.Left := ScaleX(16);
  CheckCursor.Top := Y;
  CheckCursor.Width := ToolsPage.SurfaceWidth - ScaleX(32);
  CheckCursor.Height := ScaleY(22);
  CheckCursor.Caption := 'Cursor / IDE with custom OpenAI base URL';
  CheckCursor.Checked := False;

  Y := Y + ScaleY(28);
  CheckGrok := TNewCheckBox.Create(ToolsPage);
  CheckGrok.Parent := ToolsPage.Surface;
  CheckGrok.Left := ScaleX(16);
  CheckGrok.Top := Y;
  CheckGrok.Width := ToolsPage.SurfaceWidth - ScaleX(32);
  CheckGrok.Height := ScaleY(22);
  CheckGrok.Caption := 'Grok / xAI API';
  CheckGrok.Checked := False;

  Y := Y + ScaleY(28);
  CheckOpenAI := TNewCheckBox.Create(ToolsPage);
  CheckOpenAI.Parent := ToolsPage.Surface;
  CheckOpenAI.Left := ScaleX(16);
  CheckOpenAI.Top := Y;
  CheckOpenAI.Width := ToolsPage.SurfaceWidth - ScaleX(32);
  CheckOpenAI.Height := ScaleY(22);
  CheckOpenAI.Caption := 'OpenAI API (SDKs, ChatGPT API apps)';
  CheckOpenAI.Checked := True;

  Y := Y + ScaleY(28);
  CheckOther := TNewCheckBox.Create(ToolsPage);
  CheckOther.Parent := ToolsPage.Surface;
  CheckOther.Left := ScaleX(16);
  CheckOther.Top := Y;
  CheckOther.Width := ToolsPage.SurfaceWidth - ScaleX(32);
  CheckOther.Height := ScaleY(22);
  CheckOther.Caption := 'Other OpenAI-compatible tools (via local proxy)';
  CheckOther.Checked := False;

  { --- Cloud page --- }
  CloudPage := CreateInputQueryPage(ToolsPage.ID,
    'TokenOps cloud',
    'Connect this machine to your TokenOps account',
    'Create a PAT at: {#MyDashboard}  →  Settings → Create token');
  CloudPage.Add('API URL:', False);
  CloudPage.Add('Ingest PAT (tok_…):', False);
  CloudPage.Add('Machine name:', False);
  CloudPage.Values[0] := '{#MyDefaultApi}';
  CloudPage.Values[1] := '';
  CloudPage.Values[2] := GetEnv('COMPUTERNAME');
  if CloudPage.Values[2] = '' then
    CloudPage.Values[2] := 'desktop';

  { --- Optional keys --- }
  KeysPage := CreateInputQueryPage(CloudPage.ID,
    'API keys (optional)',
    'Stored as Windows user environment variables',
    'Leave blank to set later. Keys never leave this PC for TokenOps cloud.');
  KeysPage.Add('OPENAI_API_KEY (optional):', False);
  KeysPage.Add('XAI_API_KEY (optional):', False);
  KeysPage.Values[0] := '';
  KeysPage.Values[1] := '';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
end;

procedure SetUserEnv(const Name, Value: string);
begin
  RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', Name, Value);
end;

procedure AppendUserPath(const Dir: string);
var
  OldPath, NewPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OldPath) then
    OldPath := '';
  if Pos(UpperCase(Dir), UpperCase(OldPath)) > 0 then
    Exit;
  if (OldPath <> '') and (OldPath[Length(OldPath)] <> ';') then
    NewPath := OldPath + ';' + Dir
  else
    NewPath := OldPath + Dir;
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
end;

procedure WriteLauncher(const Path, AppDir: string);
var
  Lines: TArrayOfString;
begin
  SetArrayLength(Lines, 4);
  Lines[0] := '@echo off';
  Lines[1] := 'setlocal';
  Lines[2] := 'set "TOKENOPS_HOME=' + AppDir + '"';
  Lines[3] := 'node "%TOKENOPS_HOME%\dist\cli.js" %*';
  SaveStringsToFile(Path, Lines, False);
end;

procedure WriteConfig;
var
  ConfigDir, ConfigPath, IdentityPath, BinDir, AppDir: string;
  Upstream, OtelListen, CloudUrl, Pat, MachineName: string;
  UseClaude, UseCursor, UseGrok, UseOpenAI, UseOther, ProxyOn: Boolean;
  Lines: TArrayOfString;
  OpenAIKey, XaiKey: string;
  EnvList: string;
  Manifest: string;
  GuidStr: string;
begin
  AppDir := ExpandConstant('{app}');
  ConfigDir := ExpandConstant('{userappdata}\..\.tokenops');
  { Resolve to %USERPROFILE%\.tokenops }
  ConfigDir := ExpandConstant('{userdocs}\..\.tokenops');
  ConfigDir := GetEnv('USERPROFILE') + '\.tokenops';
  ConfigPath := ConfigDir + '\config.toml';
  IdentityPath := ConfigDir + '\machine.json';
  BinDir := ExpandConstant('{localappdata}\TokenOps\bin');

  UseClaude := CheckClaude.Checked;
  UseCursor := CheckCursor.Checked;
  UseGrok := CheckGrok.Checked;
  UseOpenAI := CheckOpenAI.Checked;
  UseOther := CheckOther.Checked;
  ProxyOn := UseOpenAI or UseCursor or UseOther or UseGrok;

  Upstream := 'https://api.openai.com';
  if UseGrok and (not UseOpenAI) and (not UseCursor) and (not UseOther) then
    Upstream := 'https://api.x.ai/v1';

  if UseClaude then
    OtelListen := '127.0.0.1:4318'
  else
    OtelListen := '';

  CloudUrl := Trim(CloudPage.Values[0]);
  if CloudUrl = '' then
    CloudUrl := '{#MyDefaultApi}';
  Pat := Trim(CloudPage.Values[1]);
  MachineName := Trim(CloudPage.Values[2]);
  if MachineName = '' then
    MachineName := 'desktop';

  OpenAIKey := Trim(KeysPage.Values[0]);
  XaiKey := Trim(KeysPage.Values[1]);

  ForceDirectories(ConfigDir);
  ForceDirectories(BinDir);

  { config.toml }
  SetArrayLength(Lines, 24);
  Lines[0] := '# Generated by TokenOps-Agent-Setup ' + GetDateTimeString('yyyy-mm-dd', '-', ':');
  Lines[1] := '[cloud]';
  Lines[2] := 'url = "' + EscapeToml(CloudUrl) + '"';
  Lines[3] := 'ingest_token = "' + EscapeToml(Pat) + '"';
  Lines[4] := '';
  Lines[5] := '[privacy]';
  Lines[6] := 'content_mode = "local"';
  Lines[7] := 'content_ttl_days = 7';
  Lines[8] := '';
  Lines[9] := '[proxy]';
  Lines[10] := 'listen = "127.0.0.1:8787"';
  Lines[11] := 'upstream = "' + EscapeToml(Upstream) + '"';
  Lines[12] := '';
  Lines[13] := '[sources]';
  Lines[14] := 'openai_proxy = ' + BoolToml(ProxyOn);
  Lines[15] := 'claude_code = ' + BoolToml(UseClaude);
  Lines[16] := 'claude_code_path = ""';
  Lines[17] := 'claude_code_otel_listen = "' + EscapeToml(OtelListen) + '"';
  Lines[18] := '';
  Lines[19] := '[machine]';
  Lines[20] := 'name = "' + EscapeToml(MachineName) + '"';
  Lines[21] := '';
  SaveStringsToFile(ConfigPath, Lines, False);

  { machine identity }
  if not FileExists(IdentityPath) then
  begin
    GuidStr := GetDateTimeString('yyyymmddhhnnss', '', '') + '-' +
      IntToStr(Random(99999999)) + '-' + IntToStr(Random(99999999));
    SetArrayLength(Lines, 4);
    Lines[0] := '{';
    Lines[1] := '  "machineId": "' + GuidStr + '",';
    Lines[2] := '  "machineName": "' + EscapeToml(MachineName) + '"';
    Lines[3] := '}';
    SaveStringsToFile(IdentityPath, Lines, False);
  end;

  { launchers }
  WriteLauncher(AppDir + '\tokenops.cmd', AppDir);
  WriteLauncher(BinDir + '\tokenops.cmd', AppDir);
  AppendUserPath(BinDir);

  EnvList := '';

  if UseClaude then
  begin
    SetUserEnv('CLAUDE_CODE_ENABLE_TELEMETRY', '1');
    SetUserEnv('OTEL_METRICS_EXPORTER', 'otlp');
    SetUserEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
    SetUserEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    EnvList := EnvList + 'CLAUDE_CODE_ENABLE_TELEMETRY,OTEL_METRICS_EXPORTER,OTEL_EXPORTER_OTLP_PROTOCOL,OTEL_EXPORTER_OTLP_ENDPOINT,';
    { Desktop helper for Claude }
    SetArrayLength(Lines, 7);
    Lines[0] := '@echo off';
    Lines[1] := 'set CLAUDE_CODE_ENABLE_TELEMETRY=1';
    Lines[2] := 'set OTEL_METRICS_EXPORTER=otlp';
    Lines[3] := 'set OTEL_EXPORTER_OTLP_PROTOCOL=http/json';
    Lines[4] := 'set OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318';
    Lines[5] := 'claude %*';
    Lines[6] := '';
    SaveStringsToFile(ExpandConstant('{userdesktop}\Claude Code + TokenOps.cmd'), Lines, False);
  end;

  if UseCursor or UseOther then
  begin
    SetUserEnv('OPENAI_BASE_URL', 'http://127.0.0.1:8787/v1');
    SetUserEnv('OPENAI_API_BASE', 'http://127.0.0.1:8787/v1');
    EnvList := EnvList + 'OPENAI_BASE_URL,OPENAI_API_BASE,';
  end;

  if OpenAIKey <> '' then
  begin
    SetUserEnv('OPENAI_API_KEY', OpenAIKey);
    EnvList := EnvList + 'OPENAI_API_KEY,';
  end;
  if XaiKey <> '' then
  begin
    SetUserEnv('XAI_API_KEY', XaiKey);
    EnvList := EnvList + 'XAI_API_KEY,';
  end;

  { manifest for uninstall cleanup }
  Manifest :=
    '{' +
    '"installedAt":"' + GetDateTimeString('yyyy-mm-dd"T"hh:nn:ss', '-', ':') + '",' +
    '"installDir":"' + EscapeToml(AppDir) + '",' +
    '"envVars":"' + EscapeToml(EnvList) + '",' +
    '"startupTask":' + BoolToml(WizardIsTaskSelected('startup')) +
    '}';
  SaveStringToFile(ExpandConstant('{localappdata}\TokenOps\install-manifest.json'), Manifest, False);

  { Broadcast env change }
  { SMTO_ABORTIFHUNG = 2 }
  { SendMessageTimeout is not available easily — users open a new terminal }
end;

function CreateStartupTask: Boolean;
var
  ResultCode: Integer;
  AppDir, Cmd: string;
begin
  Result := True;
  if not WizardIsTaskSelected('startup') then
  begin
    Exec('schtasks.exe', '/Delete /TN "TokenOpsAgent" /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exit;
  end;
  AppDir := ExpandConstant('{app}');
  Cmd :=
    '/Create /F /TN "TokenOpsAgent" /SC ONLOGON /RL LIMITED ' +
    '/TR "\"' + ExpandConstant('{cmd}') + '\" /c \"' + AppDir + '\tokenops.cmd\" agent run" ' +
    '/RU "' + GetUserNameString + '"';
  if not Exec('schtasks.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteConfig;
    CreateStartupTask;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  Manifest, EnvCsv: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec('schtasks.exe', '/Delete /TN "TokenOpsAgent" /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    if LoadStringFromFile(ExpandConstant('{localappdata}\TokenOps\install-manifest.json'), Manifest) then
    begin
      { crude parse of envVars CSV field }
      if Pos('"envVars":"', Manifest) > 0 then
      begin
        EnvCsv := Copy(Manifest, Pos('"envVars":"', Manifest) + 11, Length(Manifest));
        if Pos('"', EnvCsv) > 0 then
          EnvCsv := Copy(EnvCsv, 1, Pos('"', EnvCsv) - 1);
        { only clear TokenOps-owned non-secret vars }
        if Pos('CLAUDE_CODE_ENABLE_TELEMETRY', EnvCsv) > 0 then
          RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'CLAUDE_CODE_ENABLE_TELEMETRY');
        if Pos('OTEL_METRICS_EXPORTER', EnvCsv) > 0 then
          RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'OTEL_METRICS_EXPORTER');
        if Pos('OTEL_EXPORTER_OTLP_PROTOCOL', EnvCsv) > 0 then
          RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'OTEL_EXPORTER_OTLP_PROTOCOL');
        if Pos('OTEL_EXPORTER_OTLP_ENDPOINT', EnvCsv) > 0 then
          RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'OTEL_EXPORTER_OTLP_ENDPOINT');
        if Pos('OPENAI_BASE_URL', EnvCsv) > 0 then
          RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'OPENAI_BASE_URL');
        if Pos('OPENAI_API_BASE', EnvCsv) > 0 then
          RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'OPENAI_API_BASE');
      end;
    end;
    DeleteFile(ExpandConstant('{userdesktop}\Claude Code + TokenOps.cmd'));
  end;
end;
