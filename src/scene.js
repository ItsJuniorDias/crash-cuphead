import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FilmShader } from './filmShader.js';
import { CONFIG, COLORS as C, PARALLAX, CLOUDS, PLANE, DAY_CYCLE } from './config.js';
import { multiplierAt } from './game.js';
import { makeCanvas, outlinedText } from './draw.js';

const VIEW_H = 10;                                  // altura visível em unidades de mundo
const PAD = { l: 1.1, r: 2.6, t: 1.4, b: 1.0 };      // margens do gráfico (direita/topo: espaço para o avião)
const N_PTS = 100;                                   // resolução da curva
const ORDER = { sky: 0, stars: 0.5, sun: 1, grid: 50, label: 51, fill: 52, ink: 53, line: 54, plane: 60, fx: 70, title: 90, kaboom: 100 };
const DEBRIS_COLORS = [C.red, C.cream, C.gold, '#6b4a2e'];

function material(opts = {}) {
  return new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, ...opts });
}
const aspectOf = (t) => t.image.width / t.image.height;

function sprite(texture, height, order) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(height * aspectOf(texture), height), material({ map: texture }));
  mesh.renderOrder = order;
  return mesh;
}

function niceStep(range) {
  const raw = range / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
const { smoothstep } = THREE.MathUtils;
const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

/** Hora do dia a partir do multiplicador: 0 = dia, 0.5 = pôr do sol, 1 = noite (escala log). */
function timeOfDay(m) {
  const { dayUntil, duskAt, nightAt } = DAY_CYCLE, l = Math.log(m);
  if (m <= duskAt) return 0.5 * smoothstep(l, Math.log(dayUntil), Math.log(duskAt));
  return 0.5 + 0.5 * smoothstep(l, Math.log(duskAt), Math.log(nightAt));
}

/**
 * Material que mistura duas imagens (dia → noite) com o mesmo UV, para as variantes geradas
 * a partir da mesma composição. uRepeat/uOffset fazem o papel de texture.repeat/offset.
 */
function crossfadeMaterial(mapA, mapB) {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      mapA: { value: mapA }, mapB: { value: mapB ?? mapA }, uMix: { value: 0 }, uOpacity: { value: 1 },
      uRepeat: { value: new THREE.Vector2(1, 1) }, uOffset: { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: 'uniform vec2 uRepeat, uOffset; varying vec2 vUv; void main(){ vUv = uv * uRepeat + uOffset; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D mapA, mapB; uniform float uMix, uOpacity; varying vec2 vUv;
      void main() {
        // mistura pré-multiplicada: onde só uma das imagens tem desenho, a cor transparente
        // da outra não "suja" o cross-fade
        vec4 a = texture2D(mapA, vUv), b = texture2D(mapB, vUv);
        float alpha = mix(a.a, b.a, uMix);
        vec3 rgb = mix(a.rgb * a.a, b.rgb * b.a, uMix) / max(alpha, 1e-4);
        gl_FragColor = vec4(rgb, alpha * uOpacity);
      }`,
  });
}

/** Sprite com cross-fade entre duas imagens; o tamanho vem da imagem A. */
function crossfadeSprite(mapA, mapB, height, order) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(height * aspectOf(mapA), height), crossfadeMaterial(mapA, mapB));
  mesh.renderOrder = order;
  return mesh;
}

/** Mesh com textura de canvas 2D, redesenhada só quando a chave muda. */
class CanvasSprite {
  constructor(wPx, hPx, worldH, order) {
    this.canvas = makeCanvas(wPx, hPx);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldH * wPx / hPx, worldH), material({ map: this.texture }));
    this.mesh.renderOrder = order;
    this.key = null;
  }
  draw(key, fn) {
    if (key === this.key) return;
    this.key = key;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    fn(this.ctx, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
  }
}

/** Fita de triângulos ao longo de uma polilinha (traço grosso) ou até uma base (preenchimento). */
class Ribbon {
  constructor(maxPoints, mat, order) {
    this.positions = new Float32Array(maxPoints * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    const index = [];
    for (let i = 0; i < maxPoints - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
  }
  stroke(pts, width) {
    const p = this.positions, n = pts.length, hw = width / 2;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const len = Math.hypot(tx, ty);
      if (len < 1e-6) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
      const o = i * 6;
      p[o] = pts[i][0] - ty * hw; p[o + 1] = pts[i][1] + tx * hw; p[o + 2] = 0;
      p[o + 3] = pts[i][0] + ty * hw; p[o + 4] = pts[i][1] - tx * hw; p[o + 5] = 0;
    }
    this.#commit(n);
  }
  fill(pts, baseY) {
    const p = this.positions;
    pts.forEach(([x, y], i) => {
      const o = i * 6;
      p[o] = x; p[o + 1] = y; p[o + 2] = 0;
      p[o + 3] = x; p[o + 4] = baseY; p[o + 5] = 0;
    });
    this.#commit(pts.length);
  }
  #commit(n) {
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.setDrawRange(0, (n - 1) * 6);
  }
}

function drawTitle(ctx, w, h, lines) {
  const gap = 12;
  let y = (h - (lines.reduce((s, l) => s + l.size, 0) + gap * (lines.length - 1))) / 2;
  for (const l of lines) {
    if (l.bar != null) {
      const bw = 480, x = (w - bw) / 2;
      ctx.lineWidth = 6; ctx.strokeStyle = C.ink;
      ctx.beginPath(); ctx.roundRect(x, y, bw, l.size, l.size / 2); ctx.fillStyle = C.cream; ctx.fill(); ctx.stroke();
      if (l.bar > 0) {
        ctx.beginPath(); ctx.roundRect(x, y, Math.max(l.size, bw * l.bar), l.size, l.size / 2);
        ctx.fillStyle = C.red; ctx.fill(); ctx.stroke();
      }
    } else {
      outlinedText(ctx, l.text, w / 2, y + l.size / 2, l.size, l.color, { maxWidth: w - 40 });
    }
    y += l.size + gap;
  }
}

export class World {
  scroll = 0; speed = 0; alt = 0; iris = 0; shake = 0; flash = 0; planeAngle = 0; propPhase = 0; propSpeed = 0; tod = 0;

  constructor(container, tex) {
    this.container = container;
    this.tex = tex;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-8, 8, VIEW_H / 2, -VIEW_H / 2, 0.1, 100);
    this.camera.position.z = 10;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.film = new ShaderPass(FilmShader);
    this.composer.addPass(this.film);
    this.composer.addPass(new OutputPass());

    this.#build();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  #build() {
    const s = this.scene, t = this.tex;

    // céu: dia → pôr do sol → noite (imagens geradas ou gradientes) + raios de sol girando, estilo cartaz antigo
    const skyTex = (k) => t[k] ?? null, has = (k) => (t[k] ? 1 : 0), ta = (k) => (t[k] ? aspectOf(t[k]) : 1);
    const col = (hex) => new THREE.Color(hex);
    this.skyMat = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uAspect: { value: 1.6 }, uSun: { value: new THREE.Vector2(0.8, 0.82) }, uTod: { value: 0 },
        uDayBottom: { value: col(C.skyBottom) }, uDayTop: { value: col(C.skyTop) },
        uDuskBottom: { value: col(DAY_CYCLE.sky.dusk[0]) }, uDuskTop: { value: col(DAY_CYCLE.sky.dusk[1]) },
        uNightBottom: { value: col(DAY_CYCLE.sky.night[0]) }, uNightTop: { value: col(DAY_CYCLE.sky.night[1]) },
        tDay: { value: skyTex('sky') }, tDusk: { value: skyTex('skyDusk') }, tNight: { value: skyTex('skyNight') },
        uHas: { value: new THREE.Vector3(has('sky'), has('skyDusk'), has('skyNight')) },
        uTexAspect: { value: new THREE.Vector3(ta('sky'), ta('skyDusk'), ta('skyNight')) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uTime, uAspect, uTod;
        uniform vec3 uDayBottom, uDayTop, uDuskBottom, uDuskTop, uNightBottom, uNightTop, uHas, uTexAspect;
        uniform vec2 uSun; uniform sampler2D tDay, tDusk, tNight;
        varying vec2 vUv;
        vec2 cover(float texAspect) {
          vec2 uv = vUv; float ra = uAspect / texAspect;
          if (ra > 1.0) uv.y = (uv.y - 0.5) / ra + 0.5; else uv.x = (uv.x - 0.5) * ra + 0.5;
          return uv;
        }
        void main() {
          vec3 day = uHas.x > 0.5 ? texture2D(tDay, cover(uTexAspect.x)).rgb : mix(uDayBottom, uDayTop, vUv.y);
          vec3 dusk = uHas.y > 0.5 ? texture2D(tDusk, cover(uTexAspect.y)).rgb : mix(uDuskBottom, uDuskTop, vUv.y);
          vec3 night = uHas.z > 0.5 ? texture2D(tNight, cover(uTexAspect.z)).rgb : mix(uNightBottom, uNightTop, vUv.y);
          vec3 col = mix(day, dusk, smoothstep(0.0, 0.5, uTod));
          col = mix(col, night, smoothstep(0.5, 1.0, uTod));
          // raios do sol: dourados de dia, alaranjados no pôr do sol, somem à noite
          vec2 d = vUv - uSun; d.x *= uAspect;
          float rays = step(0.0, sin(atan(d.y, d.x) * 9.0 + uTime * 0.05 * 9.0));
          vec3 rayCol = mix(vec3(1.0, 0.96, 0.86), vec3(1.0, 0.7, 0.42), smoothstep(0.0, 0.5, uTod));
          float strength = 0.22 * (1.0 - smoothstep(0.45, 0.62, uTod));
          col = mix(col, rayCol, rays * strength * smoothstep(1.4, 0.1, length(d)));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.skyMat);
    this.sky.renderOrder = ORDER.sky;
    s.add(this.sky);

    this.sun = crossfadeSprite(t.sun, t.sunDusk, 1.9, ORDER.sun);   // sol do dia → sol do pôr do sol
    this.moon = sprite(t.moon, 1.8, ORDER.sun);   // o sol "vira" a lua no mesmo lugar
    this.moon.visible = false;
    s.add(this.sun, this.moon);

    // céu estrelado: estrelas piscando, espalhadas de forma fixa (hash) na parte de cima
    this.stars = Array.from({ length: DAY_CYCLE.stars }, (_, i) => {
      const mesh = sprite(t.star, 0.12 + hash(i, 1) * 0.22, ORDER.stars);
      mesh.visible = false;
      s.add(mesh);
      return { mesh, u: hash(i, 2), v: 0.38 + hash(i, 3) * 0.6, rate: 1.5 + hash(i, 4) * 3, phase: hash(i, 5) * 6.28, spin: hash(i, 6) - 0.5 };
    });

    this.inkColor = new THREE.Color(C.ink);
    this.creamColor = new THREE.Color(C.cream);

    this.clouds = CLOUDS.map((c, i) => {
      const mesh = crossfadeSprite(t[c.tex], t[`${c.tex}Night`], c.height, c.order);
      s.add(mesh);
      return { ...c, i, mesh };
    });

    this.layers = PARALLAX.map((l) => {
      const map = t[l.name], night = t[`${l.name}Night`];
      // assets gerados não emendam perfeitamente → espelhar a cada repetição esconde a emenda
      for (const m of [map, night]) {
        if (!m) continue;
        m.wrapS = m.userData.generated ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
        m.needsUpdate = true;
      }
      // arte gerada vem recortada rente ao desenho; a procedural tem folga em cima
      const height = map.userData.generated ? (l.artHeight ?? l.height) : l.height;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, height), crossfadeMaterial(map, night));
      mesh.renderOrder = l.order;
      s.add(mesh);
      return { ...l, height, mesh, map, aspect: aspectOf(map) };
    });

    // grade do gráfico + rótulos
    this.grid = Array.from({ length: 10 }, () => {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.035), material({ map: t.dash, color: C.ink, opacity: 0.45 }));
      line.renderOrder = ORDER.grid;
      const label = new CanvasSprite(160, 56, 0.36, ORDER.label);
      s.add(line, label.mesh);
      return { line, label };
    });

    // curva: preenchimento + contorno de tinta + traço vermelho
    this.pts = Array.from({ length: N_PTS }, () => [0, 0]);
    this.fillRibbon = new Ribbon(N_PTS, material({ color: C.red, opacity: 0.18 }), ORDER.fill);
    this.inkRibbon = new Ribbon(N_PTS, material({ color: C.ink }), ORDER.ink);
    this.lineRibbon = new Ribbon(N_PTS, material({ color: C.red }), ORDER.line);
    s.add(this.fillRibbon.mesh, this.inkRibbon.mesh, this.lineRibbon.mesh);

    // avião
    this.plane = new THREE.Group();
    const planeH = Math.min(PLANE.height, PLANE.maxWidth / aspectOf(t.plane));
    this.planeMesh = sprite(t.plane, planeH, ORDER.plane);
    this.plane.add(this.planeMesh);
    // hélice animada por quadros, presa no nariz. Sem âncora (avião gerado com a hélice
    // desenhada, versão antiga) não há sobreposição.
    const nose = t.plane.userData.propeller;
    if (nose && t.propFrames?.length) {
      const { width: w, height: h } = this.planeMesh.geometry.parameters;
      const propH = PLANE.propHeight * (planeH / PLANE.height);
      const x = (nose.u - 0.5) * w + PLANE.propOffset.x, y = (0.5 - nose.v) * h + PLANE.propOffset.y;
      // disco de borrão atrás da pá (aparece em alta rotação)
      this.propBlur = new THREE.Mesh(new THREE.PlaneGeometry(propH * 0.3, propH * 1.04), material({ map: t.propBlur, opacity: 0 }));
      this.propBlur.renderOrder = ORDER.plane + 0.5;
      this.propBlur.position.set(x, y, 0);
      this.prop = sprite(t.propFrames[0], propH, ORDER.plane + 1);
      this.prop.position.set(x, y, 0);
      this.planeMesh.add(this.propBlur, this.prop);
    }
    s.add(this.plane);

    // partículas (fumaça, destroços, moedas) em pool
    this.particles = Array.from({ length: 80 }, () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material({ map: t.smoke }));
      m.renderOrder = ORDER.fx;
      m.visible = false;
      s.add(m);
      return m;
    });

    this.kaboom = new THREE.Group();
    this.kaboom.add(sprite(t.kaboom, 3.2, ORDER.kaboom));
    const kabText = new CanvasSprite(512, 160, 1.0, ORDER.kaboom + 1);
    kabText.draw('kaboom', (ctx, w, h) => outlinedText(ctx, 'KA-BOOM!', w / 2, h / 2, 96, C.cream, { rot: -0.08, maxWidth: w - 20 }));
    this.kaboom.add(kabText.mesh);
    this.kaboom.visible = false;
    s.add(this.kaboom);

    this.title = new CanvasSprite(1024, 400, 3.6, ORDER.title);
    this.title.mesh.position.set(0, 2.0, 0);
    s.add(this.title.mesh);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);

    const aspect = w / h;
    this.viewW = VIEW_H * aspect;
    Object.assign(this.camera, { left: -this.viewW / 2, right: this.viewW / 2, top: VIEW_H / 2, bottom: -VIEW_H / 2 });
    this.camera.updateProjectionMatrix();
    this.film.uniforms.uAspect.value = aspect;

    const skyW = this.viewW + 2, skyH = VIEW_H + 2;   // margem para o tremor de câmera
    this.sky.scale.set(skyW, skyH, 1);
    this.skyMat.uniforms.uAspect.value = skyW / skyH;
    this.sun.position.set(-this.viewW * 0.3, 3.3, 0);   // canto superior esquerdo: o avião sobe pela direita
    this.moon.position.copy(this.sun.position);
    this.skyMat.uniforms.uSun.value.set((this.sun.position.x + skyW / 2) / skyW, (this.sun.position.y + skyH / 2) / skyH);

    for (const l of this.layers) {
      l.mesh.scale.x = this.viewW + 2;
      l.mesh.material.uniforms.uRepeat.value.x = (this.viewW + 2) / (l.height * l.aspect);
    }

    const g = this.graph = {
      left: -this.viewW / 2 + PAD.l, right: this.viewW / 2 - PAD.r,
      bottom: -VIEW_H / 2 + PAD.b, top: VIEW_H / 2 - PAD.t,
    };
    this.tex.dash.repeat.x = (g.right - g.left) / 0.35;
    for (const { line, label } of this.grid) {
      line.scale.x = g.right - g.left;
      line.position.x = (g.left + g.right) / 2;
      label.mesh.position.x = -this.viewW / 2 + 0.55;
    }
  }

  onPhase(phase) {
    if (phase === 'waiting') {
      this.iris = 0;
      this.tod = 0;   // amanhece por trás da íris
      this.kaboom.visible = false;
      for (const p of this.particles) p.visible = false;
    } else if (phase === 'crashed') {
      this.#boom(this.plane.position.x, this.plane.position.y);
      this.shake = 1;
      this.flash = 0.35;
    }
  }

  coins() {
    const { x, y } = this.plane.position;
    for (let i = 0; i < 16; i++) {
      const a = Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 2 + Math.random() * 3.5;
      this.#spawn(this.tex.coin, x, y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 10, life: 1.4, size: 0.32, flip: true, phase: Math.random() * 6 });
    }
  }

  #boom(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, sp = 0.8 + Math.random() * 3;
      this.#spawn(this.tex.smoke, x, y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 0.6, vr: (Math.random() - 0.5) * 2, life: 1.3 + Math.random(), size: 0.45 + Math.random() * 0.4, grow: true });
    }
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = 4 + Math.random() * 4;
      this.#spawn(this.tex.debris, x, y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 14, vr: (Math.random() - 0.5) * 14, life: 2.2, size: 0.16, aspect: 64 / 24, color: DEBRIS_COLORS[i % 4] });
    }
    if (this.prop) {   // a hélice sai voando, girando
      const p = this.prop.getWorldPosition(new THREE.Vector3());
      const map = this.tex.propFrames[0];
      this.#spawn(map, p.x, p.y, { vx: 2.5 + Math.random() * 2, vy: 7, g: 13, vr: 16, life: 2.2, size: this.prop.geometry.parameters.height, aspect: aspectOf(map) });
    }
    const margin = 2.6;
    this.kaboom.position.set(
      THREE.MathUtils.clamp(x, -this.viewW / 2 + margin, this.viewW / 2 - margin),
      THREE.MathUtils.clamp(y, -2.5, 3.0), 0);
    this.kaboom.userData = { life: 1.6, max: 1.6 };
    this.kaboom.visible = true;
  }

  #spawn(map, x, y, d) {
    const p = this.particles.find((m) => !m.visible);
    if (!p) return;
    p.material.map = map;
    p.material.color.set(d.color ?? '#ffffff');
    p.material.opacity = 1;
    p.position.set(x, y, 0);
    p.rotation.z = Math.random() * Math.PI * 2;
    p.userData = { g: 0, vr: 0, ...d, aspect: d.aspect ?? aspectOf(map), max: d.life };
    p.visible = true;
  }

  update(game, dt, time) {
    const { phase } = game;
    const m = phase === 'waiting' ? 1 : game.multiplier;
    const targetSpeed = phase === 'flying' ? 1.6 + 1.2 * Math.log(m) : phase === 'waiting' ? 0.12 : 0.05;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 3);
    this.scroll += this.speed * dt;
    // "altitude": o chão afunda conforme o multiplicador sobe (parallax vertical)
    const targetAlt = Math.min(1, Math.log(m) / Math.log(25));
    this.alt += (targetAlt - this.alt) * Math.min(1, dt * (phase === 'waiting' ? 4 : 2));
    this.iris = Math.min(1, this.iris + dt * 1.3);
    this.shake = Math.max(0, this.shake - dt * 2);
    this.flash = Math.max(0, this.flash - dt * 3);
    const frame = Math.floor(time * 12);   // 12 fps de "animação desenhada à mão"

    const targetTod = phase === 'waiting' ? 0 : timeOfDay(m);
    this.tod += (targetTod - this.tod) * Math.min(1, dt * DAY_CYCLE.speed);
    this.skyMat.uniforms.uTime.value = time;
    this.skyMat.uniforms.uTod.value = this.tod;
    this.#updateSunMoon(time);
    this.#updateStars(time);

    const span = this.viewW + 4;
    for (const c of this.clouds) {
      const x = (((c.x * span - this.scroll * c.speed) % span) + span) % span - span / 2;
      c.mesh.position.set(x, c.y - c.sink * this.alt + (((frame + c.i) % 3) - 1) * 0.015, 0);
    }
    for (const l of this.layers) {
      l.mesh.position.y = -VIEW_H / 2 + l.bottom + l.height / 2 - l.sink * this.alt;
      l.mesh.material.uniforms.uOffset.value.x = (this.scroll * l.speed) / (l.height * l.aspect);
    }

    // cenário e nuvens trocam para as versões noturnas geradas
    const nightMix = smoothstep(this.tod, ...DAY_CYCLE.nightFade);
    for (const l of this.layers) l.mesh.material.uniforms.uMix.value = nightMix;
    for (const c of this.clouds) c.mesh.material.uniforms.uMix.value = nightMix;

    this.lastMultiplier = m;
    const tip = this.#updateGraph(game);
    this.#updatePlane(phase, tip, dt, time);
    this.#updateTitle(game, time);
    this.#updateParticles(dt, time);

    this.camera.position.x = (Math.random() - 0.5) * 0.5 * this.shake;
    this.camera.position.y = (Math.random() - 0.5) * 0.5 * this.shake;

    const u = this.film.uniforms;
    u.uFrame.value = frame;
    u.uIris.value = this.iris;
    u.uFlash.value = this.flash;
    u.uNight.value = smoothstep(this.tod, 0.5, 1);
    this.composer.render(dt);
  }

  /** O sol desce e esquenta no pôr do sol, depois vira (como uma carta) a lua no mesmo lugar. */
  #updateSunMoon(time) {
    const tod = this.tod;
    const dip = smoothstep(tod, 0.1, 0.5) * (1 - smoothstep(tod, 0.62, 0.9));   // desce no pôr do sol e volta
    const flip = smoothstep(tod, 0.55, 0.75);                                   // 0 = sol, 1 = lua
    const y = 3.3 - 0.4 * this.alt - 0.9 * dip + Math.sin(flip * Math.PI) * 0.3;
    const squash = Math.max(0.02, Math.abs(Math.cos(flip * Math.PI)));
    const isMoon = flip >= 0.5;
    this.sun.visible = !isMoon;
    this.moon.visible = isMoon;
    const body = isMoon ? this.moon : this.sun;
    body.position.y = y;
    body.scale.set(squash, 1, 1);
    body.rotation.z = isMoon ? Math.sin(time * 0.8) * 0.06 - 0.1 : Math.sin(time * 1.5) * 0.08;
    this.sun.material.uniforms.uMix.value = smoothstep(tod, 0.1, 0.5);   // sol alaranjado do pôr do sol
    this.skyMat.uniforms.uSun.value.y = y / this.sky.scale.y + 0.5;   // raios seguem o sol
  }

  #updateStars(time) {
    const fade = smoothstep(this.tod, 0.6, 1);
    const span = this.viewW + 1;
    for (const st of this.stars) {
      const m = st.mesh;
      m.visible = fade > 0.01;
      if (!m.visible) continue;
      const twinkle = 0.55 + 0.45 * Math.sin(time * st.rate + st.phase);
      m.material.opacity = fade * twinkle;
      m.scale.setScalar(0.85 + 0.15 * twinkle);
      m.rotation.z = st.spin * time * 0.3;
      m.position.set((((st.u * span - this.scroll * 0.015) % span) + span) % span - span / 2, -VIEW_H / 2 + st.v * VIEW_H - 0.3 * this.alt, 0);
    }
  }

  #updateGraph(game) {
    const g = this.graph, airborne = game.phase !== 'waiting';
    const t = airborne ? game.elapsed : 0, m = airborne ? game.multiplier : 1;
    const maxT = Math.max(10, t * 1.12), maxM = Math.max(2, m * 1.18);
    const X = (s) => g.left + (s / maxT) * (g.right - g.left);
    const Y = (v) => g.bottom + ((v - 1) / (maxM - 1)) * (g.top - g.bottom);

    const step = niceStep(maxM - 1);
    const night = smoothstep(this.tod, 0.55, 0.85), labelColor = night > 0.5 ? C.cream : C.ink;
    this.grid.forEach(({ line, label }, k) => {
      line.material.color.copy(this.inkColor).lerp(this.creamColor, night);
      const v = 1 + step * (k + 1);
      const show = v < maxM - 1e-9;
      line.visible = label.mesh.visible = show;
      if (!show) return;
      line.position.y = label.mesh.position.y = Y(v);
      const text = `${v.toFixed(v < 10 ? 1 : 0)}×`;
      label.draw(text + labelColor, (ctx, w, h) => {
        ctx.font = '34px "Special Elite"'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillStyle = labelColor; ctx.fillText(text, w - 8, h / 2);
      });
    });

    const ribbons = [this.fillRibbon, this.inkRibbon, this.lineRibbon];
    if (!airborne) {
      ribbons.forEach((r) => { r.mesh.visible = false; });
      return { x: X(0), y: Y(1), a: 0 };
    }
    for (let i = 0; i < N_PTS; i++) {
      const s = (t * i) / (N_PTS - 1);
      this.pts[i][0] = X(s);
      this.pts[i][1] = Y(Math.min(m, multiplierAt(s)));
    }
    this.fillRibbon.fill(this.pts, g.bottom);
    this.fillRibbon.mesh.material.opacity = 0.18 * (1 - 0.65 * smoothstep(this.tod, 0.5, 1));   // à noite o vermelho vira um facho rosa
    this.inkRibbon.stroke(this.pts, 0.2);
    this.lineRibbon.stroke(this.pts, 0.1);
    this.lineRibbon.mesh.material.color.set(game.phase === 'crashed' ? C.redDark : C.red);
    ribbons.forEach((r) => { r.mesh.visible = true; });
    const a = this.pts[N_PTS - 4], b = this.pts[N_PTS - 1];
    return { x: b[0], y: b[1], a: Math.atan2(b[1] - a[1], b[0] - a[0]) || 0 };
  }

  #updatePlane(phase, tip, dt, time) {
    const flying = phase === 'flying';
    this.plane.visible = phase !== 'crashed';
    const target = THREE.MathUtils.clamp(tip.a * 0.8, -0.2, 0.55);   // inclinação contida, mais legível
    this.planeAngle += (target - this.planeAngle) * Math.min(1, dt * 8);
    // a ponta da curva fica sob a cauda: o avião vai à frente (forward) e um pouco acima (lift)
    const a = this.planeAngle, lift = this.planeMesh.geometry.parameters.height * 0.25;
    const forward = this.planeMesh.geometry.parameters.width * 0.35;
    const bob = flying ? Math.sin(time * 9) * 0.05 : Math.sin(time * 20) * 0.01;
    this.plane.position.set(
      tip.x + Math.cos(a) * forward - Math.sin(a) * lift,
      tip.y + Math.sin(a) * forward + Math.cos(a) * lift + bob, 0);
    this.plane.rotation.z = a;
    const sq = flying ? Math.sin(time * 16) * 0.025 : 0;   // squash & stretch "rubber hose"
    this.planeMesh.scale.set(1 - sq * 0.5, 1 + sq, 1);
    if (this.prop) {
      const sp = PLANE.propSpeed, bl = PLANE.propBlur, frames = this.tex.propFrames;
      const target = flying ? sp.flying + sp.perLogMultiplier * Math.log(this.lastMultiplier) : sp.idle;
      this.propSpeed += (target - this.propSpeed) * Math.min(1, dt * sp.spinUp);   // acelera/desacelera suave
      this.propPhase += dt * this.propSpeed;
      this.prop.material.map = frames[Math.floor(this.propPhase) % frames.length];
      // em alta rotação a pá fica translúcida e o borrão assume, como nos desenhos dos anos 30
      const blur = THREE.MathUtils.smoothstep(this.propSpeed, bl.from, bl.to);
      this.propBlur.material.opacity = blur * bl.opacity * (0.85 + 0.15 * Math.sin(time * 40));
      this.propBlur.scale.y = 0.96 + 0.04 * Math.sin(time * 33);
      this.prop.material.opacity = 1 - 0.55 * blur;
    }
  }

  #updateTitle(game, time) {
    let lines;
    if (game.phase === 'waiting') {
      const k = Math.max(0, game.timer);
      lines = [
        { text: 'NEXT FLIGHT', size: 100, color: C.cream },
        { text: `${k.toFixed(1)}s`, size: 80, color: C.gold },
        { bar: Math.round((k / CONFIG.waitTime) * 200) / 200, size: 26 },
      ];
    } else if (game.phase === 'flying') {
      const m = game.multiplier;
      lines = [{ text: `${m.toFixed(2)}×`, size: 180 * (1 + Math.min(0.2, Math.log(m) * 0.04)), color: m >= 10 ? C.gold : C.cream }];
    } else {
      lines = [
        { text: 'CRASHED!', size: 100, color: C.red },
        { text: `${game.crashPoint.toFixed(2)}×`, size: 150, color: C.cream },
      ];
    }
    this.title.draw(JSON.stringify(lines), (ctx, w, h) => drawTitle(ctx, w, h, lines));
    this.title.mesh.rotation.z = game.phase === 'flying' ? Math.sin(time * 3) * 0.02 : 0;
  }

  #updateParticles(dt, time) {
    for (const p of this.particles) {
      if (!p.visible) continue;
      const d = p.userData;
      d.life -= dt;
      if (d.life <= 0) { p.visible = false; continue; }
      d.vy -= d.g * dt;
      p.position.x += d.vx * dt;
      p.position.y += d.vy * dt;
      p.rotation.z += d.vr * dt;
      const k = d.life / d.max;
      p.material.opacity = Math.min(1, k * 1.5);
      let sx = d.size * (d.aspect ?? 1), sy = d.size;
      if (d.grow) { sx *= 2 - k; sy *= 2 - k; }
      if (d.flip) sx *= Math.cos(time * 12 + d.phase) || 0.01;
      p.scale.set(sx, sy, 1);
    }
    if (this.kaboom.visible) {
      const d = this.kaboom.userData;
      d.life -= dt;
      if (d.life <= 0) { this.kaboom.visible = false; return; }
      const age = d.max - d.life;
      this.kaboom.scale.setScalar(easeOutBack(Math.min(1, age * 5)));
      this.kaboom.rotation.z = Math.sin(age * 20) * 0.04 * (d.life / d.max);
      for (const child of this.kaboom.children) child.material.opacity = Math.min(1, d.life * 2.5);
    }
  }
}
