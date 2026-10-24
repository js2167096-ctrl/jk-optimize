// Temas de cores do painel: uma única lista usada pelas Configurações, pela validação e pelos tipos.
// As paletas ficam em renderer/styles/tokens.css ([data-theme='...']); aqui só ficam id e nome.
export const THEMES = [
  { id: 'blue', label: 'Azul elétrico', swatch: '#2f7bff' },
  { id: 'red', label: 'Vermelho intenso', swatch: '#ff1835' },
  { id: 'ruby', label: 'Rosa rubi', swatch: '#e11d74' },
  { id: 'violet', label: 'Violeta neon', swatch: '#9b5cff' },
  { id: 'emerald', label: 'Verde esmeralda', swatch: '#10b981' },
  { id: 'gold', label: 'Amarelo dourado', swatch: '#f5b301' },
  { id: 'cyan', label: 'Ciano elétrico', swatch: '#00c8ff' }
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id)
export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v)
