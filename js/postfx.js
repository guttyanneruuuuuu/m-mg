// ===========================================================
// postfx.js — custom post-processing shaders
//   - Chromatic aberration (RGB split scaled by speed)
//   - Vignette + film grain
// ===========================================================

import * as THREE from 'three';

export const ChromaShader = {
  uniforms: {
    tDiffuse:  { value: null },
    amount:    { value: 0.0 },     // 0..1 strength of RGB split
    radius:    { value: 0.0 },     // pull-toward-edge factor
    vignette:  { value: 0.45 },    // 0..1 vignette strength
    grain:     { value: 0.05 },    // 0..0.2 grain
    time:      { value: 0.0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float radius;
    uniform float vignette;
    uniform float grain;
    uniform float time;
    varying vec2 vUv;

    float rand(vec2 co){
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main(){
      vec2 uv = vUv;
      vec2 center = vec2(0.5);
      vec2 dir = uv - center;
      float dist = length(dir);

      // Chromatic aberration: shift R/B channels along radial direction.
      // Stronger near edges, scaled by speed via 'amount'.
      vec2 offset = dir * (amount + dist * radius);
      float r = texture2D(tDiffuse, uv - offset * 1.0).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv + offset * 1.0).b;
      vec3 col = vec3(r, g, b);

      // Vignette
      float v = smoothstep(0.85, 0.20, dist);
      col *= mix(1.0 - vignette, 1.0, v);

      // Subtle grain
      float n = (rand(uv * 800.0 + time) - 0.5) * grain;
      col += n;

      gl_FragColor = vec4(col, 1.0);
    }
  `
};
