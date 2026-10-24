; Inno Setup Script for devLauncher
; Per-user install: no administrator rights required (school PCs, lab machines).
; Build: "iscc installer.iss" from the repository root after "npm run dist:win".
; Output: dist/devLauncher-Setup-<version>.exe
#define MyAppName "devLauncher"
#define MyAppVersion "0.13.0"
#define MyAppPublisher "unstablecelik"
#define MyAppURL "https://github.com/unstablecelik/devLauncher"
#define MyAppExeName "devLauncher.exe"

[Setup]
AppId={{C682F419-5632-4467-85F0-55D44081016A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
; Per-user install into %LOCALAPPDATA%\Programs — no admin prompt, no UAC.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
; Quiet self-update flow: updater launches Setup with
; /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RESTARTAPPLICATIONS
CloseApplications=yes
RestartApplications=yes
Uninstallable=yes
UninstallDisplayName={#MyAppName} {#MyAppVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}
LicenseFile=LICENSE
OutputDir=dist
OutputBaseFilename=devLauncher-Setup-{#MyAppVersion}
SetupIconFile=assets\icons\installer.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\win-unpacked\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
