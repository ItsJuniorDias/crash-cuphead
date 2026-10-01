// Pós-processamento "filme dos anos 30": granulado, vinheta, viragem sépia, riscos,
// poeira, flicker, tremidinha a 12 fps (boil) e a transição de íris.
export const FilmShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFrame: { value: 0 },      // contador a 12 fps
    uIris: { value: 1 },       // 0 = tela fechada, 1 = aberta
    uAspect: { value: 1.6 },
    uFlash: { value: 0 },
    uGrain: { value: 0.07 },
    uVignette: { value: 0.6 },
    uSepia: { value: 0.25 },
    uNight: { value: 0 },      // 0 = dia, 1 = noite: menos sépia (não "esquenta" o azul da noite) e vinheta mais forte
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFrame, uIris, uAspect, uFlash, uGrain, uVignette, uSepia, uNight;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      float f = uFrame;
      vec2 uv = vUv + (vec2(hash(vec2(f, 1.0)), hash(vec2(f, 7.0))) - 0.5) * 0.0016;
      vec3 col = texture2D(tDiffuse, uv).rgb;

      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l * 1.07, l * 0.95, l * 0.76), uSepia * (1.0 - 0.6 * uNight));

      col += (hash(vUv * vec2(1931.0, 1087.0) + f * 13.37) - 0.5) * uGrain;

      vec2 d = vUv - 0.5; d.x *= uAspect;
      col *= 1.0 - (uVignette + 0.15 * uNight) * smoothstep(0.45, 1.15, length(d) * 1.3);

      if (hash(vec2(f, 9.0)) > 0.7) {
        float sx = hash(vec2(f, 3.0));
        col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.0012, abs(vUv.x - sx)));
      }
      vec2 dp = vUv - vec2(hash(vec2(f, 11.0)), hash(vec2(f, 17.0))); dp.x *= uAspect;
      col *= mix(0.35, 1.0, smoothstep(0.002, 0.004, length(dp)));

      col *= 0.97 + 0.05 * hash(vec2(f, 23.0));
      col += uFlash;

      float r = pow(uIris, 1.6) * 0.5 * length(vec2(uAspect, 1.0)) * 1.02;
      col *= smoothstep(r, r - 0.004, length(d));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
