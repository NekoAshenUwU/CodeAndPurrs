// 落予棠海面: sirxemic/jquery.ripples 的 WebGL 涟漪逐行移植版(不带 jQuery)。
//
// 之前自研 shader 反复调不出参考效果,按老婆明确指示放弃自研,把 jquery.ripples
// 的 drop / update / render 三个着色器 **原样** 搬进现有 canvas 框架:
//   - 三个 fragment shader 与 render vertex shader 的 GLSL 一字未改
//     (来源 https://github.com/sirxemic/jquery.ripples/blob/master/src/main.js);
//   - 坐标系也照搬它的:仿真纹理对应"以画布长边为边长的正方形"区域
//     (containerRatio),drop 坐标/半径都按长边归一化,圆天然是圆;
//   - 背景纹理接入是唯一按我们项目改的部分:它原版从 jQuery 元素的
//     background-size/position 计算 topLeft/bottomRight,我们这里固定按
//     background-size:cover 的裁切数学来算(canvas 即整个可视区)。
//
// 与原库不同、但属于工程接入(不是效果上的自由发挥)的点,都注释标明:
//   1. 仿真纹理显式清零——原库 half-float 路径传 null data(内容未定义),
//      真机上踩过"第一帧满屏噪声"的坑,必须清;
//   2. render 不开 BLEND——原库 canvas 是叠在元素背景上的透明层,我们的
//      canvas 是唯一画面来源(不透明),混合无意义还引入 alpha 歧义;
//   3. render 采样"当前最新"的那张 ping-pong 纹理(原库固定采样 textures[0],
//      隔帧才是最新——效果上等价,这里取正确的那张);
//   4. 保留临时诊断:热力图分支(uDebugVisualize)/readPixels 读数/渲染帧计数。

import { debugError, debugInfo } from './debugLog';

export type RippleOptions = {
  resolution?: number; // 仿真纹理边长,默认 256(与原库默认一致)
  dropRadius?: number; // 水花半径,CSS 像素(原库默认 20)
  perturbance?: number; // 折射扰动强度(原库默认 0.03)
};

// ── 以下 4 段 GLSL 逐字来自 jquery.ripples,不要改 ────────────────────────

const SIM_VERTEX_SRC = `
attribute vec2 vertex;
varying vec2 coord;
void main() {
  coord = vertex * 0.5 + 0.5;
  gl_Position = vec4(vertex, 0.0, 1.0);
}
`;

const DROP_FRAG_SRC = `
precision highp float;

const float PI = 3.141592653589793;
uniform sampler2D texture;
uniform vec2 center;
uniform float radius;
uniform float strength;

varying vec2 coord;

void main() {
  vec4 info = texture2D(texture, coord);

  float drop = max(0.0, 1.0 - length(center * 0.5 + 0.5 - coord) / radius);
  drop = 0.5 - cos(drop * PI) * 0.5;

  info.r += drop * strength;

  gl_FragColor = info;
}
`;

const UPDATE_FRAG_SRC = `
precision highp float;

uniform sampler2D texture;
uniform vec2 delta;

varying vec2 coord;

void main() {
  vec4 info = texture2D(texture, coord);

  vec2 dx = vec2(delta.x, 0.0);
  vec2 dy = vec2(0.0, delta.y);

  float average = (
    texture2D(texture, coord - dx).r +
    texture2D(texture, coord - dy).r +
    texture2D(texture, coord + dx).r +
    texture2D(texture, coord + dy).r
  ) * 0.25;

  info.g += (average - info.r) * 2.0;
  info.g *= 0.995;
  info.r += info.g;

  gl_FragColor = info;
}
`;

const RENDER_VERTEX_SRC = `
precision highp float;

attribute vec2 vertex;
uniform vec2 topLeft;
uniform vec2 bottomRight;
uniform vec2 containerRatio;
varying vec2 ripplesCoord;
varying vec2 backgroundCoord;

void main() {
  backgroundCoord = mix(topLeft, bottomRight, vertex * 0.5 + 0.5);
  backgroundCoord.y = 1.0 - backgroundCoord.y;
  ripplesCoord = vec2(vertex.x, -vertex.y) * containerRatio * 0.5 + 0.5;
  gl_Position = vec4(vertex.x, -vertex.y, 0.0, 1.0);
}
`;

// 唯一的改动: 开头加了 uDebugVisualize 热力图分支(临时诊断用,开关关闭时
// 走的就是原版逐字未动的那段)。
const RENDER_FRAG_SRC = `
precision highp float;

uniform sampler2D samplerBackground;
uniform sampler2D samplerRipples;
uniform vec2 delta;

uniform float perturbance;
uniform int uDebugVisualize;
varying vec2 ripplesCoord;
varying vec2 backgroundCoord;

void main() {
  if (uDebugVisualize == 1) {
    float h = texture2D(samplerRipples, ripplesCoord).r;
    if (h >= 0.0) {
      gl_FragColor = vec4(0.5 + h * 6.0, 0.5, 0.5, 1.0);
    } else {
      gl_FragColor = vec4(0.5, 0.5, 0.5 - h * 6.0, 1.0);
    }
    return;
  }
  float height = texture2D(samplerRipples, ripplesCoord).r;
  float heightX = texture2D(samplerRipples, vec2(ripplesCoord.x + delta.x, ripplesCoord.y)).r;
  float heightY = texture2D(samplerRipples, vec2(ripplesCoord.x, ripplesCoord.y + delta.y)).r;
  vec3 dx = vec3(delta.x, heightX - height, 0.0);
  vec3 dy = vec3(0.0, heightY - height, delta.y);
  vec2 offset = -normalize(cross(dy, dx)).xz;
  float specular = pow(max(0.0, dot(offset, normalize(vec2(-0.6, 1.0)))), 4.0);
  gl_FragColor = texture2D(samplerBackground, backgroundCoord + offset * perturbance) + specular;
}
`;

// ── GLSL 到此为止,下面是接入框架 ─────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader 失败');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram 失败');
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败: ${log}`);
  }
  return program;
}

type SimTarget = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };

// 跟原库一样的浮点纹理格式探测,只是把"真的能渲染到这个格式"用
// checkFramebufferStatus 实测出来(扩展字符串在≠真能用,这个坑踩过)。
// LINEAR 过滤是 jquery.ripples 顺滑观感的关键一环,对应 *_linear 扩展;
// 没有就退 NEAREST(原库也是这么退的,只是糙一点)。
type SimConfig = { type: number; linear: boolean };

function detectSimConfig(gl: WebGLRenderingContext, size: number): SimConfig | null {
  const candidates: Array<{ ext: string; linearExt: string; type: () => number | null }> = [
    {
      ext: 'OES_texture_float',
      linearExt: 'OES_texture_float_linear',
      type: () => (gl.getExtension('OES_texture_float') ? gl.FLOAT : null),
    },
    {
      ext: 'OES_texture_half_float',
      linearExt: 'OES_texture_half_float_linear',
      type: () => {
        const ext = gl.getExtension('OES_texture_half_float') as { HALF_FLOAT_OES: number } | null;
        return ext ? ext.HALF_FLOAT_OES : null;
      },
    },
  ];
  for (const c of candidates) {
    const type = c.type();
    if (type === null) continue;
    const probe = createSimTarget(gl, size, type, false);
    if (!probe) continue;
    gl.deleteFramebuffer(probe.framebuffer);
    gl.deleteTexture(probe.texture);
    const linear = !!gl.getExtension(c.linearExt);
    debugInfo(`[waterRipples] 仿真纹理格式: ${c.ext}${linear ? ' + linear 过滤' : '(NEAREST 过滤)'}`);
    return { type, linear };
  }
  return null;
}

function createSimTarget(
  gl: WebGLRenderingContext,
  size: number,
  type: number,
  linear: boolean,
): SimTarget | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, type, null);

  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    gl.deleteTexture(texture);
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  return { texture, framebuffer };
}

export class WaterRipples {
  private gl: WebGLRenderingContext;
  private canvas: HTMLCanvasElement;
  private resolution: number;
  private dropRadius: number;
  private perturbance: number;

  private quadBuffer: WebGLBuffer;
  private dropProgram: WebGLProgram;
  private updateProgram: WebGLProgram;
  private renderProgram: WebGLProgram;

  private targetA: SimTarget;
  private targetB: SimTarget;
  private srcIsA = true; // 当前"最新状态"在 A 还是 B

  private bgTexture: WebGLTexture | null = null;
  private bgImageSize = { w: 1, h: 1 };
  private dpr = 1;

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private loggedFirstRender = false; // 临时诊断: render() 真的跑起来了没有,只打一次
  private debugVisualize = false; // 临时诊断: 高度场热力图开关
  private frameCount = 0; // 临时诊断: 渲染帧计数,验证"点击后渲染循环持续在跑"

  constructor(canvas: HTMLCanvasElement, opts: RippleOptions = {}) {
    this.canvas = canvas;
    // 三个默认值都取 jquery.ripples 的默认(resolution 256 / dropRadius 20 /
    // perturbance 0.03),官网 demo 就是这组参数的观感。
    this.resolution = opts.resolution ?? 256;
    this.dropRadius = opts.dropRadius ?? 20;
    this.perturbance = opts.perturbance ?? 0.03;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('拿不到 WebGL 上下文');
    this.gl = gl;

    const config = detectSimConfig(gl, this.resolution);
    if (!config) throw new Error('设备不支持渲染到浮点纹理,涟漪不可用');

    const targetA = createSimTarget(gl, this.resolution, config.type, config.linear);
    const targetB = createSimTarget(gl, this.resolution, config.type, config.linear);
    if (!targetA || !targetB) throw new Error('ping-pong 纹理创建失败');
    this.targetA = targetA;
    this.targetB = targetB;

    // 原库对 half-float 传 null data,内容按规范是未定义的——真机踩过
    // "第一帧满屏噪声"的坑,这里显式清成静止水面(全 0)。
    for (const t of [this.targetA, this.targetB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
      gl.viewport(0, 0, this.resolution, this.resolution);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.dropProgram = linkProgram(gl, SIM_VERTEX_SRC, DROP_FRAG_SRC);
    this.updateProgram = linkProgram(gl, SIM_VERTEX_SRC, UPDATE_FRAG_SRC);
    this.renderProgram = linkProgram(gl, RENDER_VERTEX_SRC, RENDER_FRAG_SRC);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  async loadImage(url: string): Promise<void> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`背景图加载失败: ${url}`));
      image.src = url;
    });
    if (this.destroyed) return;
    const gl = this.gl;
    this.bgImageSize = { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
    const texture = gl.createTexture();
    if (!texture) throw new Error('createTexture 失败');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // 不翻转 Y——render vertex shader(原版)自己做了 backgroundCoord.y = 1-y,
    // 背景按 DOM 常规方向上传才对得上。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.bgTexture = texture;
  }

  // 手指在画布归一化坐标(0~1)按下 → 起一圈涟漪。
  // 坐标换算照搬原库 drop():以画布长边为归一化基准,center 在 [-1,1] 区间,
  // drop shader 里再 *0.5+0.5 映射回纹理空间——正方形仿真纹理对应画布上
  // "长边 x 长边"的正方形区域,圆就是圆,不需要额外的宽高比补丁。
  // radius/strength 默认取原库 mousedown 的档位(dropRadius*1.5, 0.14)。
  drop(u: number, v: number, radiusScale = 1.5, strength = 0.14) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const longestSide = Math.max(w, h);
    const x = u * w;
    const y = v * h;
    const radius = (this.dropRadius * this.dpr * radiusScale) / longestSide;
    const center = [(2 * x - w) / longestSide, (h - 2 * y) / longestSide];

    const src = this.srcIsA ? this.targetA : this.targetB;
    const dst = this.srcIsA ? this.targetB : this.targetA;
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.useProgram(this.dropProgram);
    this.bindQuad(this.dropProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(this.dropProgram, 'texture'), 0);
    gl.uniform2f(gl.getUniformLocation(this.dropProgram, 'center'), center[0], center[1]);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'radius'), radius);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'strength'), strength);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.srcIsA = !this.srcIsA;

    // 临时诊断: 验证"点击后渲染循环持续在跑"(验收标准是 2 秒 ≥ 100 帧上下,
    // 60fps 屏是 ~120 帧)。
    const framesAtDrop = this.frameCount;
    window.setTimeout(() => {
      if (this.destroyed) return;
      debugInfo(`[waterRipples] drop 后 2 秒内渲染了 ${this.frameCount - framesAtDrop} 帧(60fps 屏应 ~120)`);
    }, 2000);
  }

  // 临时诊断: readPixels 读一个点的高度字节值。float/half-float 帧缓冲在这台
  // 设备上 CPU 读回会失败(返回 null)——这是已知设备限制,不代表渲染有问题,
  // 看热力图/画面就行,这个读数仅供参考。
  debugReadHeightByteAt(u: number, v: number): number | null {
    const gl = this.gl;
    const state = this.srcIsA ? this.targetA : this.targetB;
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
    const x = Math.max(0, Math.min(this.resolution - 1, Math.round(u * this.resolution)));
    const y = Math.max(0, Math.min(this.resolution - 1, Math.round((1 - v) * this.resolution)));
    const pixel = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const err = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (err !== gl.NO_ERROR) return null;
    return pixel[0];
  }

  // 临时诊断: 切换 render() 是否改画高度场热力图(灰底、凸起=红、凹陷=蓝)。
  setDebugVisualize(on: boolean) {
    this.debugVisualize = on;
  }

  private bindQuad(program: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const loc = gl.getAttribLocation(program, 'vertex');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private update() {
    const gl = this.gl;
    const src = this.srcIsA ? this.targetA : this.targetB;
    const dst = this.srcIsA ? this.targetB : this.targetA;
    const delta = 1 / this.resolution;

    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.useProgram(this.updateProgram);
    this.bindQuad(this.updateProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram, 'texture'), 0);
    gl.uniform2f(gl.getUniformLocation(this.updateProgram, 'delta'), delta, delta);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.srcIsA = !this.srcIsA;
  }

  // 对应原库 computeTextureBoundaries:算 topLeft/bottomRight(背景图按
  // background-size:cover 裁切后,画布对应到图片 UV 的窗口)和 containerRatio
  // (画布相对"长边正方形"的比例,决定仿真纹理如何铺到画布上)。
  private computeUniforms(): { topLeft: [number, number]; bottomRight: [number, number]; containerRatio: [number, number] } {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const scale = Math.max(w / this.bgImageSize.w, h / this.bgImageSize.h);
    const dispW = this.bgImageSize.w * scale;
    const dispH = this.bgImageSize.h * scale;
    const left = (dispW - w) / 2;
    const top = (dispH - h) / 2;
    const topLeft: [number, number] = [left / dispW, top / dispH];
    const bottomRight: [number, number] = [topLeft[0] + w / dispW, topLeft[1] + h / dispH];
    const maxSide = Math.max(w, h);
    const containerRatio: [number, number] = [w / maxSide, h / maxSide];
    return { topLeft, bottomRight, containerRatio };
  }

  private render() {
    const gl = this.gl;
    if (!this.bgTexture && !this.debugVisualize) {
      if (!this.loggedFirstRender) {
        this.loggedFirstRender = true;
        debugError('[waterRipples] render() 跑起来了,但 bgTexture 还是空的——每帧都直接 return,画面不会更新');
      }
      return;
    }
    if (!this.loggedFirstRender) {
      this.loggedFirstRender = true;
      debugInfo(
        `[waterRipples] render() 第一次真正执行, canvas 内部渲染尺寸=${this.canvas.width}x${this.canvas.height}`,
      );
    }
    this.frameCount++;
    const state = this.srcIsA ? this.targetA : this.targetB;
    const delta = 1 / this.resolution;
    const { topLeft, bottomRight, containerRatio } = this.computeUniforms();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.renderProgram);
    this.bindQuad(this.renderProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTexture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'samplerBackground'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'samplerRipples'), 1);
    gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'delta'), delta, delta);
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'perturbance'), this.perturbance);
    gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'topLeft'), topLeft[0], topLeft[1]);
    gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'bottomRight'), bottomRight[0], bottomRight[1]);
    gl.uniform2f(
      gl.getUniformLocation(this.renderProgram, 'containerRatio'),
      containerRatio[0],
      containerRatio[1],
    );
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'uDebugVisualize'), this.debugVisualize ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 跟原库一样: rAF 循环常开(update+render 每帧都跑),不做"drop 才渲染一帧"
  // 的省电小聪明——波在传播期间必须持续渲染,不然光纹不会跟着波走。
  start() {
    if (this.rafId !== null) return;
    const loop = () => {
      if (this.destroyed) return;
      this.update();
      this.render();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteProgram(this.dropProgram);
    gl.deleteProgram(this.updateProgram);
    gl.deleteProgram(this.renderProgram);
    gl.deleteFramebuffer(this.targetA.framebuffer);
    gl.deleteTexture(this.targetA.texture);
    gl.deleteFramebuffer(this.targetB.framebuffer);
    gl.deleteTexture(this.targetB.texture);
    if (this.bgTexture) gl.deleteTexture(this.bgTexture);
  }
}

// 供 React 组件调用的安全入口:构造+加载图片全程 try/catch,任何一步失败
// (WebGL 不可用/浮点纹理渲染不支持/图片加载失败)都返回 null,
// 调用方据此走"只保留焦散层,涟漪关闭"的降级路径。
export async function createWaterRipples(
  canvas: HTMLCanvasElement,
  imageUrl: string,
  opts?: RippleOptions,
): Promise<WaterRipples | null> {
  try {
    const engine = new WaterRipples(canvas, opts);
    await engine.loadImage(imageUrl);
    return engine;
  } catch (err) {
    debugError(
      `[waterRipples] 不支持或初始化失败，降级为纯焦散层: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
