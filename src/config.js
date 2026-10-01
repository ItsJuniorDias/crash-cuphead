export const CONFIG = {
  houseEdge: 0.03,     // P(crash >= x) = (1 - edge) / x
  growth: 0.085,       // multiplier = e^(growth * seconds)  → 2× em ~8s, 10× em ~27s
  waitTime: 6,         // segundos de apostas antes da decolagem
  crashPause: 3.2,     // segundos mostrando a queda
  maxCrash: 1000,
  startBalance: 1000,
};

export const COLORS = {
  ink: '#1b1410', paper: '#f3e3c3', cream: '#fbf1dc',
  red: '#c8312b', redDark: '#8f1f1a', gold: '#e7b53c', orange: '#e8742b',
  smoke: '#5a4a3c', hillFar: '#a9b57d', hillNear: '#7f9a5a',
  skyTop: '#f6e6c2', skyBottom: '#e2c38c',
};

// Camadas de parallax (faixas que se repetem na horizontal), de trás para frente.
// height/bottom em unidades de mundo (a tela tem 10 de altura). height vale para a arte procedural
// (que tem folga transparente em cima); artHeight é a altura do desenho gerado, recortado rente.
// Ajuste artHeight se uma faixa gerada parecer alta ou baixa demais;
// speed = fração da velocidade do mundo; sink = quanto a camada desce quando o avião ganha altitude;
// order = ordem de desenho (o gráfico fica em 50, o avião em 60).
export const PARALLAX = [
  { name: 'mountains',  height: 3.6, artHeight: 2.4,  bottom: 0.6,   speed: 0.10, sink: 0.8, order: 10 },
  { name: 'hills',      height: 2.8, artHeight: 1.75, bottom: 0.0,   speed: 0.28, sink: 1.6, order: 20 },
  { name: 'trees',      height: 2.2, artHeight: 1.9,  bottom: -0.1,  speed: 0.55, sink: 2.4, order: 30 },
  { name: 'ground',     height: 1.4, artHeight: 1.05, bottom: -0.1,  speed: 1.00, sink: 3.2, order: 40 },
  { name: 'foreground', height: 1.2, artHeight: 0.8,  bottom: -0.35, speed: 1.70, sink: 4.0, order: 80 },
];

// Nuvens soltas (sprites). x = posição inicial em fração da largura.
export const CLOUDS = [
  { tex: 'cloud1', x: 0.05, y: 3.3, height: 0.9, speed: 0.06, sink: 0.3, order: 5 },
  { tex: 'cloud2', x: 0.45, y: 3.9, height: 1.0, speed: 0.06, sink: 0.3, order: 5 },
  { tex: 'cloud1', x: 0.80, y: 2.6, height: 0.8, speed: 0.06, sink: 0.3, order: 5 },
  { tex: 'cloud2', x: 0.25, y: 1.4, height: 1.4, speed: 0.40, sink: 2.0, order: 25 },
  { tex: 'cloud1', x: 0.70, y: 0.6, height: 1.6, speed: 0.45, sink: 2.2, order: 25 },
];

// Avião e hélice animada (quadros propeller_0..n.png, ou procedurais).
export const PLANE = {
  height: 1.8,                   // altura do avião em unidades de mundo (a tela tem 10)
  maxWidth: 3.8,                 // limite de largura (um avião gerado muito comprido é reduzido)
  propHeight: 1.45,              // altura da hélice
  propOffset: { x: 0.04, y: 0 }, // ajuste fino da posição da hélice (x > 0 = mais à frente do nariz)
  // velocidade em quadros/s: devagar na pista, acelera na decolagem e com o multiplicador
  propSpeed: { idle: 7, flying: 26, perLogMultiplier: 8, spinUp: 2.5 },
  propBlur: { from: 16, to: 34, opacity: 0.6 },   // o disco de borrão aparece entre essas velocidades
};

// Ciclo dia → pôr do sol → noite estrelada, guiado pelo multiplicador.
export const DAY_CYCLE = {
  dayUntil: 1.5,   // até aqui é dia pleno
  duskAt: 2.5,     // auge do pôr do sol
  nightAt: 8,      // daqui em diante, noite estrelada
  speed: 1.2,      // rapidez da transição (suaviza os saltos)
  stars: 40,       // estrelas piscando por cima do céu noturno
  // as camadas e nuvens trocam para a versão noturna gerada (<nome>Night) entre estes pontos
  nightFade: [0.35, 0.95],
  // céu de reserva, só se as imagens do céu não existirem: [base, topo]
  sky: { dusk: ['#f2a46a', '#7d5f92'], night: ['#2c3866', '#121830'] },
};
