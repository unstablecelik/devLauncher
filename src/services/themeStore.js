class ThemeStore {
    static themes = {
        dark: {
            name: 'Dark (Default)',
            bgMain: '#2b2b36',
            bgDark: '#1e1e24',
            bgBar: '#141419',
            accent: '#2ecc71',
            accentHover: '#34d076',
            text: '#ffffff',
            textMuted: '#a0a0b0',
            border: '#3a3a4a'
        },
        light: {
            name: 'Light',
            bgMain: '#f5f5f7',
            bgDark: '#ffffff',
            bgBar: '#e5e5ea',
            accent: '#2ecc71',
            accentHover: '#27ae60',
            text: '#1c1c1e',
            textMuted: '#666668',
            border: '#d1d1d6'
        },
        emerald: {
            name: 'Emerald Green',
            bgMain: '#12261e',
            bgDark: '#0a1712',
            bgBar: '#060d09',
            accent: '#10b981',
            accentHover: '#34d399',
            text: '#ecfdf5',
            textMuted: '#6ee7b7',
            border: '#1e3a2b'
        },
        cyberpunk: {
            name: 'Cyberpunk Blue',
            bgMain: '#0f172a',
            bgDark: '#020617',
            bgBar: '#030712',
            accent: '#38bdf8',
            accentHover: '#7dd3fc',
            text: '#f8fafc',
            textMuted: '#94a3b8',
            border: '#1e293b'
        },
        dracula: {
            name: 'Dracula Purple',
            bgMain: '#282a36',
            bgDark: '#1e1f29',
            bgBar: '#191a21',
            accent: '#bd93f9',
            accentHover: '#ff79c6',
            text: '#f8f8f2',
            textMuted: '#6272a4',
            border: '#44475a'
        },
        oled: {
            name: 'OLED Black',
            bgMain: '#000000',
            bgDark: '#050505',
            bgBar: '#000000',
            accent: '#2ecc71',
            accentHover: '#27ae60',
            text: '#ffffff',
            textMuted: '#888888',
            border: '#222222'
        },
        'catppuccin-mocha': {
            name: 'Catppuccin Mocha',
            bgMain: '#1e1e2e',
            bgDark: '#181825',
            bgBar: '#11111b',
            accent: '#a6e3a1',
            accentHover: '#94e2d5',
            text: '#cdd6f4',
            textMuted: '#a6adc8',
            border: '#313244'
        },
        'catppuccin-macchiato': {
            name: 'Catppuccin Macchiato',
            bgMain: '#24273a',
            bgDark: '#1e2030',
            bgBar: '#181926',
            accent: '#a6da95',
            accentHover: '#8bd5ca',
            text: '#cad3f5',
            textMuted: '#a5adcb',
            border: '#363a4f'
        },
        'catppuccin-frappe': {
            name: 'Catppuccin Frappé',
            bgMain: '#303446',
            bgDark: '#292c3c',
            bgBar: '#232634',
            accent: '#a6d189',
            accentHover: '#81c8be',
            text: '#c6d0f5',
            textMuted: '#a5adce',
            border: '#414559'
        },
        'catppuccin-latte': {
            name: 'Catppuccin Latte',
            bgMain: '#eff1f5',
            bgDark: '#e6e9ef',
            bgBar: '#dce0e8',
            accent: '#40a02b',
            accentHover: '#179299',
            text: '#4c4f69',
            textMuted: '#6c6f85',
            border: '#ccd0da'
        },
        nord: {
            name: 'Nord',
            bgMain: '#2e3440',
            bgDark: '#242933',
            bgBar: '#1b1f27',
            accent: '#88c0d0',
            accentHover: '#81a1c1',
            text: '#eceff4',
            textMuted: '#d8dee9',
            border: '#434c5e'
        }
    };

    static getTheme(themeKey) {
        return this.themes[themeKey] || this.themes.dark;
    }

    static getAllThemes() {
        return this.themes;
    }
}

module.exports = ThemeStore;
