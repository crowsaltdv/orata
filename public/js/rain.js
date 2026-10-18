// Orate — rain on glass.
//
// This is Lucas Bebber's "Rain & Water Effect Experiments" (Codrops, 2015 — https://tympanus.net/Development/RainEffect/,
// https://tympanus.net/codrops/2015/11/04/rain-water-effect-experiments/) integrated into Orate: the same drop simulation
// (big drops that merge, creep down and leave trails; thousands of static droplets that big drops wipe away), the same
// drop textures (public/img/rain/drop-alpha.png + drop-color.png, used as a normal-map-like refraction lookup) and the
// same water fragment shader. Differences from the demo: the in-focus / out-of-focus textures are generated from the
// user's wallpaper instead of the demo photos, the effect is driven by Orate's settings, and the loop can be paused.
// Codrops demo code: free to integrate and build upon (see https://tympanus.net/codrops/licensing/).

import { wallpaperCanvas, makeCanvas } from '/js/wpcanvas.js';

/* ------------------------------------------------------------------ shaders (water.frag is the original, + a lightning flash) */
const VERT = `
precision mediump float;
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;

// textures
uniform sampler2D u_waterMap;
uniform sampler2D u_textureShine;
uniform sampler2D u_textureFg;
uniform sampler2D u_textureBg;

// the texCoords passed in from the vertex shader.
varying vec2 v_texCoord;
uniform vec2 u_resolution;
uniform vec2 u_parallax;
uniform float u_parallaxFg;
uniform float u_parallaxBg;
uniform float u_textureRatio;
uniform bool u_renderShine;
uniform bool u_renderShadow;
uniform float u_minRefraction;
uniform float u_refractionDelta;
uniform float u_brightness;
uniform float u_alphaMultiply;
uniform float u_alphaSubtract;
uniform float u_flash;

// alpha-blends two colors
vec4 blend(vec4 bg,vec4 fg){
  vec3 bgm=bg.rgb*bg.a;
  vec3 fgm=fg.rgb*fg.a;
  float ia=1.0-fg.a;
  float a=(fg.a + bg.a * ia);
  vec3 rgb;
  if(a!=0.0){
    rgb=(fgm + bgm * ia) / a;
  }else{
    rgb=vec3(0.0,0.0,0.0);
  }
  return vec4(rgb,a);
}

vec2 pixel(){
  return vec2(1.0,1.0)/u_resolution;
}

vec2 parallax(float v){
  return u_parallax*pixel()*v;
}

vec2 texCoord(){
  return vec2(gl_FragCoord.x, u_resolution.y-gl_FragCoord.y)/u_resolution;
}

// scales the bg up and proportionally to fill the container
vec2 scaledTexCoord(){
  float ratio=u_resolution.x/u_resolution.y;
  vec2 scale=vec2(1.0,1.0);
  vec2 offset=vec2(0.0,0.0);
  float ratioDelta=ratio-u_textureRatio;
  if(ratioDelta>=0.0){
    scale.y=(1.0+ratioDelta);
    offset.y=ratioDelta/2.0;
  }else{
    scale.x=(1.0-ratioDelta);
    offset.x=-ratioDelta/2.0;
  }
  return (texCoord()+offset)/scale;
}

// get color from fg
vec4 fgColor(float x, float y){
  float p2=u_parallaxFg*2.0;
  vec2 scale=vec2(
    (u_resolution.x+p2)/u_resolution.x,
    (u_resolution.y+p2)/u_resolution.y
  );

  vec2 scaledTexCoord=texCoord()/scale;
  vec2 offset=vec2(
    (1.0-(1.0/scale.x))/2.0,
    (1.0-(1.0/scale.y))/2.0
  );

  return texture2D(u_waterMap,
    (scaledTexCoord+offset)+(pixel()*vec2(x,y))+parallax(u_parallaxFg)
  );
}

void main() {
  vec4 bg=texture2D(u_textureBg,scaledTexCoord()+parallax(u_parallaxBg));

  vec4 cur = fgColor(0.0,0.0);

  float d=cur.b; // "thickness"
  float x=cur.g;
  float y=cur.r;

  float a=clamp(cur.a*u_alphaMultiply-u_alphaSubtract, 0.0,1.0);

  vec2 refraction = (vec2(x,y)-0.5)*2.0;
  vec2 refractionParallax=parallax(u_parallaxBg-u_parallaxFg);
  vec2 refractionPos = scaledTexCoord()
    + (pixel()*refraction*(u_minRefraction+(d*u_refractionDelta)))
    + refractionParallax;

  vec4 tex=texture2D(u_textureFg,refractionPos);

  if(u_renderShine){
    float maxShine=490.0;
    float minShine=maxShine*0.18;
    vec2 shinePos=vec2(0.5,0.5) + ((1.0/512.0)*refraction)* -(minShine+((maxShine-minShine)*d));
    vec4 shine=texture2D(u_textureShine,shinePos);
    tex=blend(tex,shine);
  }

  // lightning (Orate addition): flashes both the fogged glass and the drops
  bg.rgb=mix(bg.rgb,vec3(0.92,0.95,1.0),u_flash*0.6);
  tex.rgb=mix(tex.rgb,vec3(1.0),u_flash*0.5);

  vec4 fg=vec4(tex.rgb*u_brightness,a);

  if(u_renderShadow){
    float borderAlpha = fgColor(0.,0.-(d*6.0)).a;
    borderAlpha=borderAlpha*u_alphaMultiply-(u_alphaSubtract+0.5);
    borderAlpha=clamp(borderAlpha,0.,1.);
    borderAlpha*=0.2;
    vec4 border=vec4(0.,0.,0.,borderAlpha);
    fg=blend(border,fg);
  }

  gl_FragColor = blend(bg,fg);
}`;

/* ------------------------------------------------------------------ random helpers (random.js / times.js) */
function random(from = null, to = null, interpolation = null) {
  if (from == null) { from = 0; to = 1; } else if (to == null) { to = from; from = 0; }
  const delta = to - from;
  if (interpolation == null) interpolation = (n) => n;
  return from + interpolation(Math.random()) * delta;
}
const chance = (c) => random() <= c;
function times(n, f) { for (let i = 0; i < n; i++) f(i); }

/* ------------------------------------------------------------------ raindrops.js (drop simulation) */
const DROP_SIZE = 64;
const Drop = { x: 0, y: 0, r: 0, spreadX: 0, spreadY: 0, momentum: 0, momentumX: 0, lastSpawn: 0, nextSpawn: 0, parent: null, isNew: true, killed: false, shrink: 0 };
const defaultOptions = {
  minR: 10, maxR: 40, maxDrops: 900, rainChance: 0.3, rainLimit: 3, dropletsRate: 50, dropletsSize: [2, 4], dropletsCleaningRadiusMultiplier: 0.43,
  raining: true, globalTimeScale: 1, trailRate: 1, autoShrink: true, spawnArea: [-0.1, 0.95], trailScaleRange: [0.2, 0.5], collisionRadius: 0.65,
  collisionRadiusIncrease: 0.01, dropFallMultiplier: 1, collisionBoostMultiplier: 0.05, collisionBoost: 1,
};

class Raindrops {
  constructor(width, height, scale, dropAlpha, dropColor, options = {}) {
    this.width = width; this.height = height; this.scale = scale; this.dropAlpha = dropAlpha; this.dropColor = dropColor;
    this.options = Object.assign({}, defaultOptions, options);
    this.dropletsPixelDensity = 1; this.dropletsCounter = 0; this.textureCleaningIterations = 0; this.lastRender = null;
    this.canvas = makeCanvas(width, height); this.ctx = this.canvas.getContext('2d');
    this.droplets = makeCanvas(width * this.dropletsPixelDensity, height * this.dropletsPixelDensity); this.dropletsCtx = this.droplets.getContext('2d');
    this.drops = []; this.dropsGfx = [];
    this.renderDropsGfx();
  }
  get deltaR() { return this.options.maxR - this.options.minR; }
  get area() { return (this.width * this.height) / this.scale; }
  get areaMultiplier() { return Math.sqrt(this.area / (1024 * 768)); }
  drawDroplet(x, y, r) {
    this.drawDrop(this.dropletsCtx, Object.assign(Object.create(Drop), { x: x * this.dropletsPixelDensity, y: y * this.dropletsPixelDensity, r: r * this.dropletsPixelDensity }));
  }
  renderDropsGfx() {
    const dropBuffer = makeCanvas(DROP_SIZE, DROP_SIZE); const dropBufferCtx = dropBuffer.getContext('2d');
    this.dropsGfx = Array.apply(null, Array(255)).map((cur, i) => {
      const drop = makeCanvas(DROP_SIZE, DROP_SIZE); const dropCtx = drop.getContext('2d');
      dropBufferCtx.clearRect(0, 0, DROP_SIZE, DROP_SIZE);
      // color
      dropBufferCtx.globalCompositeOperation = 'source-over';
      dropBufferCtx.drawImage(this.dropColor, 0, 0, DROP_SIZE, DROP_SIZE);
      // blue overlay, for depth
      dropBufferCtx.globalCompositeOperation = 'screen';
      dropBufferCtx.fillStyle = `rgba(0,0,${i},1)`;
      dropBufferCtx.fillRect(0, 0, DROP_SIZE, DROP_SIZE);
      // alpha
      dropCtx.globalCompositeOperation = 'source-over';
      dropCtx.drawImage(this.dropAlpha, 0, 0, DROP_SIZE, DROP_SIZE);
      dropCtx.globalCompositeOperation = 'source-in';
      dropCtx.drawImage(dropBuffer, 0, 0, DROP_SIZE, DROP_SIZE);
      return drop;
    });
    // circle used as a brush to remove droplets
    this.clearDropletsGfx = makeCanvas(128, 128);
    const c = this.clearDropletsGfx.getContext('2d'); c.fillStyle = '#000'; c.beginPath(); c.arc(64, 64, 64, 0, Math.PI * 2); c.fill();
  }
  drawDrop(ctx, drop) {
    if (this.dropsGfx.length > 0) {
      const { x, y, r, spreadX, spreadY } = drop;
      const scaleX = 1; const scaleY = 1.5;
      let d = Math.max(0, Math.min(1, ((r - this.options.minR) / this.deltaR) * 0.9));
      d *= 1 / ((drop.spreadX + drop.spreadY) * 0.5 + 1);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      d = Math.floor(d * (this.dropsGfx.length - 1));
      ctx.drawImage(this.dropsGfx[d], (x - r * scaleX * (spreadX + 1)) * this.scale, (y - r * scaleY * (spreadY + 1)) * this.scale, r * 2 * scaleX * (spreadX + 1) * this.scale, r * 2 * scaleY * (spreadY + 1) * this.scale);
    }
  }
  clearDroplets(x, y, r = 30) {
    const ctx = this.dropletsCtx; ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(this.clearDropletsGfx, (x - r) * this.dropletsPixelDensity * this.scale, (y - r) * this.dropletsPixelDensity * this.scale, r * 2 * this.dropletsPixelDensity * this.scale, r * 2 * this.dropletsPixelDensity * this.scale * 1.5);
  }
  clearCanvas() { this.ctx.clearRect(0, 0, this.width, this.height); }
  createDrop(options) { if (this.drops.length >= this.options.maxDrops * this.areaMultiplier) return null; return Object.assign(Object.create(Drop), options); }
  updateRain(timeScale) {
    const rainDrops = [];
    if (this.options.raining) {
      const limit = this.options.rainLimit * timeScale * this.areaMultiplier; let count = 0;
      while (chance(this.options.rainChance * timeScale * this.areaMultiplier) && count < limit) {
        count++;
        const r = random(this.options.minR, this.options.maxR, (n) => Math.pow(n, 3));
        const rainDrop = this.createDrop({
          x: random(this.width / this.scale), y: random((this.height / this.scale) * this.options.spawnArea[0], (this.height / this.scale) * this.options.spawnArea[1]),
          r, momentum: 1 + (r - this.options.minR) * 0.1 + random(2), spreadX: 1.5, spreadY: 1.5,
        });
        if (rainDrop != null) rainDrops.push(rainDrop);
      }
    }
    return rainDrops;
  }
  clearDrops() {
    this.drops.forEach((drop) => { setTimeout(() => { drop.shrink = 0.1 + random(0.5); }, random(1200)); });
    this.clearTexture();
  }
  clearTexture() { this.textureCleaningIterations = 50; }
  updateDroplets(timeScale) {
    if (this.textureCleaningIterations > 0) {
      this.textureCleaningIterations -= 1 * timeScale;
      this.dropletsCtx.globalCompositeOperation = 'destination-out';
      this.dropletsCtx.fillStyle = `rgba(0,0,0,${0.05 * timeScale})`;
      this.dropletsCtx.fillRect(0, 0, this.width * this.dropletsPixelDensity, this.height * this.dropletsPixelDensity);
    }
    if (this.options.raining) {
      this.dropletsCounter += this.options.dropletsRate * timeScale * this.areaMultiplier;
      times(this.dropletsCounter, () => {
        this.dropletsCounter--;
        this.drawDroplet(random(this.width / this.scale), random(this.height / this.scale), random(...this.options.dropletsSize, (n) => n * n));
      });
    }
    this.ctx.drawImage(this.droplets, 0, 0, this.width, this.height);
  }
  updateDrops(timeScale) {
    let newDrops = [];
    this.updateDroplets(timeScale);
    newDrops = newDrops.concat(this.updateRain(timeScale));
    this.drops.sort((a, b) => { const va = a.y * (this.width / this.scale) + a.x; const vb = b.y * (this.width / this.scale) + b.x; return va > vb ? 1 : va === vb ? 0 : -1; });
    this.drops.forEach(function each(drop, i) {
      if (!drop.killed) {
        // update gravity (chance of drops "creeping down")
        if (chance((drop.r - this.options.minR * this.options.dropFallMultiplier) * (0.1 / this.deltaR) * timeScale)) drop.momentum += random((drop.r / this.options.maxR) * 4);
        // clean small drops
        if (this.options.autoShrink && drop.r <= this.options.minR && chance(0.05 * timeScale)) drop.shrink += 0.01;
        // update shrinkage
        drop.r -= drop.shrink * timeScale;
        if (drop.r <= 0) drop.killed = true;
        // update trails
        if (this.options.raining) {
          drop.lastSpawn += drop.momentum * timeScale * this.options.trailRate;
          if (drop.lastSpawn > drop.nextSpawn) {
            const trailDrop = this.createDrop({ x: drop.x + random(-drop.r, drop.r) * 0.1, y: drop.y - drop.r * 0.01, r: drop.r * random(...this.options.trailScaleRange), spreadY: drop.momentum * 0.1, parent: drop });
            if (trailDrop != null) {
              newDrops.push(trailDrop);
              drop.r *= Math.pow(0.97, timeScale); drop.lastSpawn = 0;
              drop.nextSpawn = random(this.options.minR, this.options.maxR) - drop.momentum * 2 * this.options.trailRate + (this.options.maxR - drop.r);
            }
          }
        }
        // normalize spread
        drop.spreadX *= Math.pow(0.4, timeScale); drop.spreadY *= Math.pow(0.7, timeScale);
        // update position
        const moved = drop.momentum > 0;
        if (moved && !drop.killed) {
          drop.y += drop.momentum * this.options.globalTimeScale; drop.x += drop.momentumX * this.options.globalTimeScale;
          if (drop.y > this.height / this.scale + drop.r) drop.killed = true;
        }
        // collision
        const checkCollision = (moved || drop.isNew) && !drop.killed; drop.isNew = false;
        if (checkCollision) {
          this.drops.slice(i + 1, i + 70).forEach((drop2) => {
            if (drop !== drop2 && drop.r > drop2.r && drop.parent !== drop2 && drop2.parent !== drop && !drop2.killed) {
              const dx = drop2.x - drop.x; const dy = drop2.y - drop.y; const d = Math.sqrt(dx * dx + dy * dy);
              if (d < (drop.r + drop2.r) * (this.options.collisionRadius + drop.momentum * this.options.collisionRadiusIncrease * timeScale)) {
                const pi = Math.PI; const a1 = pi * (drop.r * drop.r); const a2 = pi * (drop2.r * drop2.r);
                let targetR = Math.sqrt((a1 + a2 * 0.8) / pi);
                if (targetR > this.options.maxR * 1.5) targetR = this.options.maxR * 1.5;
                drop.r = targetR; drop.momentumX += dx * 0.1; drop.spreadX = 0; drop.spreadY = 0; drop2.killed = true;
                drop.momentum = Math.max(drop2.momentum, Math.min(40, drop.momentum + targetR * this.options.collisionBoostMultiplier + this.options.collisionBoost));
              }
            }
          });
        }
        // slowdown momentum
        drop.momentum -= Math.max(1, this.options.minR * 0.5 - drop.momentum) * 0.1 * timeScale;
        if (drop.momentum < 0) drop.momentum = 0;
        drop.momentumX *= Math.pow(0.7, timeScale);
        if (!drop.killed) {
          newDrops.push(drop);
          if (moved && this.options.dropletsRate > 0) this.clearDroplets(drop.x, drop.y, drop.r * this.options.dropletsCleaningRadiusMultiplier);
          this.drawDrop(this.ctx, drop);
        }
      }
    }, this);
    this.drops = newDrops;
  }
  /** One simulation + render step (the original schedules itself with requestAnimationFrame; Orate drives it). */
  update(now = Date.now()) {
    this.clearCanvas();
    if (this.lastRender == null) this.lastRender = now;
    const deltaT = now - this.lastRender;
    let timeScale = deltaT / ((1 / 60) * 1000);
    if (timeScale > 1.1) timeScale = 1.1;
    timeScale *= this.options.globalTimeScale;
    this.lastRender = now;
    this.updateDrops(timeScale);
  }
}

/* ------------------------------------------------------------------ rain-renderer.js + webgl helpers (the water shader pass) */
const UNIFORMS = ['u_waterMap', 'u_textureShine', 'u_textureFg', 'u_textureBg', 'u_resolution', 'u_parallax', 'u_parallaxFg', 'u_parallaxBg', 'u_textureRatio', 'u_renderShine', 'u_renderShadow', 'u_minRefraction', 'u_refractionDelta', 'u_brightness', 'u_alphaMultiply', 'u_alphaSubtract', 'u_flash'];
const renderDefaults = { renderShadow: false, minRefraction: 256, maxRefraction: 512, brightness: 1.04, alphaMultiply: 6, alphaSubtract: 3, parallaxBg: 5, parallaxFg: 20 };

class RainGL {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog); this.program = prog;
    this.u = {}; for (const n of UNIFORMS) this.u[n] = gl.getUniformLocation(prog, n);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_position'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = [];
    for (let i = 0; i < 4; i++) {
      const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.tex.push(t);
    }
    gl.uniform1i(this.u.u_waterMap, 0); gl.uniform1i(this.u.u_textureShine, 1); gl.uniform1i(this.u.u_textureFg, 2); gl.uniform1i(this.u.u_textureBg, 3);
    gl.uniform1i(this.u.u_renderShine, 0);
    this.upload(1, makeCanvas(2, 2));
    this.parallax = [0, 0]; this.flash = 0;
  }
  upload(unit, src) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, this.tex[unit]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
  configure({ width, height, fg, bg, options }) {
    const gl = this.gl; const o = Object.assign({}, renderDefaults, options);
    this.canvas.width = width; this.canvas.height = height; gl.viewport(0, 0, width, height);
    gl.uniform2f(this.u.u_resolution, width, height);
    gl.uniform1f(this.u.u_textureRatio, bg.width / bg.height);
    gl.uniform1i(this.u.u_renderShadow, o.renderShadow ? 1 : 0);
    this.setOptions(o);
    this.upload(2, fg); this.upload(3, bg);
  }
  setOptions(o) {
    const gl = this.gl; o = Object.assign({}, renderDefaults, o);
    gl.uniform1f(this.u.u_minRefraction, o.minRefraction); gl.uniform1f(this.u.u_refractionDelta, o.maxRefraction - o.minRefraction);
    gl.uniform1f(this.u.u_brightness, o.brightness); gl.uniform1f(this.u.u_alphaMultiply, o.alphaMultiply); gl.uniform1f(this.u.u_alphaSubtract, o.alphaSubtract);
    gl.uniform1f(this.u.u_parallaxBg, o.parallaxBg); gl.uniform1f(this.u.u_parallaxFg, o.parallaxFg);
  }
  draw(liquid) {
    const gl = this.gl;
    gl.uniform2f(this.u.u_parallax, this.parallax[0], this.parallax[1]); gl.uniform1f(this.u.u_flash, this.flash);
    this.upload(0, liquid);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

/* ------------------------------------------------------------------ controller (index.js: setup, parallax, lightning) */
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Weather presets — the same moods as the original demo, expressed in Orate's slider units. */
export const RAIN_PRESETS = {
  rain: { label: 'Rain', amount: 0.35, size: 1, speed: 1, refraction: 1, mist: 3, trails: 1, droplets: 50, lightning: 0 },
  drizzle: { label: 'Drizzle', amount: 0.15, size: 0.8, speed: 1, refraction: 1, mist: 2, trails: 1, droplets: 10, lightning: 0 },
  storm: { label: 'Storm', amount: 0.4, size: 1.1, speed: 1.1, refraction: 1, mist: 5, trails: 2.5, droplets: 80, lightning: 0.1 },
  fallout: { label: 'Fallout', amount: 0.35, size: 1.4, speed: 1, refraction: 1, mist: 3, trails: 4, droplets: 20, lightning: 0 },
};

class RainController {
  constructor() {
    this.canvas = document.getElementById('rain'); this.gl = null; this.drops = null; this.running = false; this.raf = 0; this.cfg = null; this.sig = '';
    this.assets = null; this.supported = true; this.last = 0; this.parallaxTarget = [0, 0]; this.flashTimer = 0; this.flashSeq = null; this.buildId = 0;
    this.onVis = () => { if (document.hidden) this.pause(); else if (this.cfg) this.resume(); };
    this.onMove = (e) => { this.parallaxTarget = [(e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1]; };
    this.onResize = null;
  }

  dropOptions(s) {
    return {
      raining: true, minR: 20 * s.size, maxR: 50 * s.size, rainChance: s.amount, rainLimit: Math.max(1, Math.round(1 + s.amount * 14)), dropletsRate: s.droplets, dropletsSize: [3, 5.5],
      trailRate: s.trails, trailScaleRange: [0.25, 0.35], collisionRadiusIncrease: 0.0002, globalTimeScale: s.speed, dropletsCleaningRadiusMultiplier: 0.28, collisionRadius: 0.45,
    };
  }
  renderOptions(s) { return { minRefraction: 256 * s.refraction, maxRefraction: 512 * s.refraction, brightness: 1.04, alphaMultiply: 6, alphaSubtract: 3 }; }

  async start(cfg) {
    const prev = this.cfg; this.cfg = cfg;
    const bg = cfg.bg; const s = cfg.settings;
    const sig = JSON.stringify([cfg.key, !!cfg.source?.img, bg.blur, bg.brightness, bg.saturate, bg.posX, bg.posY, bg.zoom, s.mist]);
    if (prev && this.gl && this.running && sig === this.sig) { this.applyLive(); this.hookInput(); return true; }   // slider tweak: no rebuild
    this.sig = sig;
    const id = ++this.buildId;
    try {
      if (!this.assets) { const [alpha, color] = await Promise.all([loadImage('/img/rain/drop-alpha.png'), loadImage('/img/rain/drop-color.png')]); this.assets = { alpha, color }; }
      if (id !== this.buildId || !this.cfg) return false;
      if (!this.gl) this.gl = new RainGL(this.canvas);
    } catch (e) { console.warn('[rain]', e.message); this.supported = false; document.getElementById('wallpaper').classList.add('rain-fallback'); return false; }
    document.getElementById('wallpaper').classList.remove('rain-fallback');
    this.build();
    this.canvas.classList.add('on');
    document.addEventListener('visibilitychange', this.onVis);
    if (!this.onResize) { let t; this.onResize = () => { clearTimeout(t); t = setTimeout(() => this.cfg && this.build(), 250); }; window.addEventListener('resize', this.onResize); }
    this.hookInput(); this.resume();
    return true;
  }
  stop() {
    this.buildId++; this.cfg = null; this.pause(); this.canvas.classList.remove('on');
    document.removeEventListener('visibilitychange', this.onVis); window.removeEventListener('pointermove', this.onMove); this.drops = null; this.sig = '';
  }
  pause() { this.running = false; cancelAnimationFrame(this.raf); clearInterval(this.flashTimer); }
  resume() {
    if (this.running || !this.cfg || document.hidden || !this.drops) return;
    this.running = true; this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t));
    clearInterval(this.flashTimer); this.flashTimer = setInterval(() => this.maybeFlash(), 500);
  }
  hookInput() {
    window.removeEventListener('pointermove', this.onMove);
    if (this.cfg?.bg.parallax && !this.cfg.reduce) window.addEventListener('pointermove', this.onMove, { passive: true }); else this.parallaxTarget = [0, 0];
  }

  /** (Re)creates everything that depends on the screen size or the wallpaper. */
  build() {
    const { source, bg, settings: s } = this.cfg; const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let W = Math.round(innerWidth * dpr); let H = Math.round(innerHeight * dpr); let d = dpr;
    if (W > 2560) { const k = 2560 / W; W = 2560; H = Math.round(H * k); d = dpr * k; }
    // the simulation canvas ("liquid") can be a little smaller than the screen without anyone noticing
    const q = clamp(1500 / W, 0.5, 1);
    const aspect = W / H;
    // in-focus miniature for the inside of the drops, and a fogged copy for the glass between them (as in the article)
    const fgTex = wallpaperCanvas(source, bg, 192, Math.round(192 / aspect));
    const mist = Math.max(0, bg.blur + s.mist) * (512 / innerWidth);
    const bgTex = wallpaperCanvas(source, bg, 512, Math.round(512 / aspect), { blur: mist });
    this.drops = new Raindrops(W * q, H * q, d * q, this.assets.alpha, this.assets.color, this.dropOptions(s));
    gl.configure({ width: W, height: H, fg: fgTex, bg: bgTex, options: this.renderOptions(s) });
  }
  applyLive() {
    const s = this.cfg.settings;
    if (this.drops) this.drops.options = Object.assign(this.drops.options, this.dropOptions(s));
    this.gl.setOptions(this.renderOptions(s));
  }

  maybeFlash() {
    const p = this.cfg?.settings.lightning || 0; if (!p || this.flashSeq || !chance(p)) return;
    // a few quick, uneven pulses — like the demo's storm
    const seq = [1, random(0.1, 0.6), random(0.2, 1), random(0.1, 0.5), 0.9, 0.35, 0]; let i = 0;
    this.flashSeq = setInterval(() => { this.gl.flash = seq[i++] * 0.9; if (i >= seq.length) { clearInterval(this.flashSeq); this.flashSeq = null; this.gl.flash = 0; } }, 55);
  }

  frame(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const fps = this.cfg.settings.fps || 60;
    if (fps < 60 && now - this.last < 1000 / fps - 2) return;
    this.last = now;
    // parallax eases toward the pointer, like the demo's TweenLite
    const p = this.gl.parallax; p[0] += (this.parallaxTarget[0] - p[0]) * 0.06; p[1] += (this.parallaxTarget[1] - p[1]) * 0.06;
    this.drops.update(Date.now());
    this.gl.draw(this.drops.canvas);
  }
}

export const rain = new RainController();
