// 落予棠海面: sirxemic/jquery.ripples 的 WebGL 涟漪逐行移植版(不带 jQuery)。
//
// ⛔️⛔️⛔️ 本模块已于 2026-07-08 真机验收定稿(棠棠亲自验收:"波光粼粼"),
// 以下内容对之后的任何 AI session / 任何人都生效——想"优化/重构/简化"之前
// 先读完这段,再去 CLAUDE.md 看"视觉资产改动必须先报备"那条新规:
//
// 【禁改区】三个 fragment shader + render vertex shader 逐字来自
// https://github.com/sirxemic/jquery.ripples/blob/master/src/main.js ,
// 唯二获批的观感精修是 render 里 specular 的 pow 4→64、强度乘 0.25,
// 和 update 里阻尼 0.995→0.99。除这两处外一字不许动。
//
// 【真机踩坑清单 = 硬约束,每一条都是在棠棠手机上流过泪的,禁止"看着多余就删"】
//   1. drop 必须走"读旧状态+加凸起+写另一张 ping-pong 纹理",禁止 gl.BLEND
//      叠加——WebGL1 对浮点渲染目标做加法混合需要 EXT_float_blend,这扩展在
//      不少手机 GPU 上"静默无效"(不报错,就是什么都不发生),真机踩过。
//   2. 禁止任何依赖 readPixels 从浮点帧缓冲读回 CPU 的逻辑(包括调试代码)——
//      真机上必失败(getError 报错),连规范"保证"的 RGBA/UNSIGNED_BYTE 组合
//      也读不回来。要诊断,用"把数据画到屏幕上看"的 GPU-only 方式。
//   3. 所有 fragment shader 必须 precision highp float(原版就是 highp)——
//      mediump 在不少手机 GPU 上是半精度浮点,2048 以上的整数都存不准,
//      任何涉及大数/打包的算术都会悄悄算错,真机踩过(高度读数恒为 -2)。
//   4. 背景纹理必须 UNPACK_FLIP_Y_WEBGL=1 翻转上传(原库 initTexture 如此),
//      render vertex shader 的 backgroundCoord.y = 1-y 是按翻转后纹理写的;
//      漏掉=整张背景上下颠倒,夕阳沉到海底,真机踩过、被当场抓包。
//   5. 仿真纹理格式必须用 createSimTarget 真实建纹理+挂 FBO+
//      checkFramebufferStatus 实测——扩展字符串"存在"不等于真能渲染进去。
//   6. 仿真纹理显式清零——half-float 传 null data 内容按规范未定义,
//      不清零=第一帧满屏噪声,真机踩过。
//
// 【移动端兼容性硬约束——纹理格式与兜底方案,禁止乱简化】
//   当前仿真纹理按原库走 float/half-float(shader 直接读写 .r/.g,并靠
//   LINEAR 过滤获得顺滑观感),在棠棠的手机上实测可渲染、已验收。
//   如果哪天某台设备连 half-float 渲染都探测失败(detectSimConfig 返回 null):
//   唯一批准的兜底是「RGBA8/UNSIGNED_BYTE + 16 位定点打包(encode16/decode16,
//   高度/速度各占两个字节通道,配 highp + NEAREST)」——完整实现在本仓库
//   git 历史 commit 2fe1382 里,直接捞回来接上,不要现场重新发明。
//   理由:RGBA8/UNSIGNED_BYTE 是 WebGL1 规范里唯一 100% 保证任何设备都能
//   "渲染到纹理"的格式,这是移动端兼容性的底线。禁止把这套"实测探测+明确
//   兜底"的结构改成"假设设备都支持 float 就直接用"的天真写法。

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
  // 阻尼从原库的 0.995 调到 0.99: 原库那档波能荡很久,几下连点之后整片海
  // 会一直"翻腾"很久不平复——水的高级感在于不碰它时温柔平静,这档衰减
  // 单圈波纹仍有 2 秒左右的完整荡开,但松手后海面能明显更快回归原图。
  info.g *= 0.99;
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

// 相对原版仅两处观感精修(验收后按老婆要求拧的半圈,不是返工):
//   1. specular 的 pow 指数 4→64、强度乘 0.25——原版那档高光又宽又白,
//      在这张浅色海面上像探照灯扫过;指数调高后光带碎成细小的"光鳞",
//      "波光粼粼"要的是鳞,不是带。
//   2. 无(其余每个字都和原版一致)。
const RENDER_FRAG_SRC = `
precision highp float;

uniform sampler2D samplerBackground;
uniform sampler2D samplerRipples;
uniform vec2 delta;

uniform float perturbance;
varying vec2 ripplesCoord;
varying vec2 backgroundCoord;

void main() {
  float height = texture2D(samplerRipples, ripplesCoord).r;
  float heightX = texture2D(samplerRipples, vec2(ripplesCoord.x + delta.x, ripplesCoord.y)).r;
  float heightY = texture2D(samplerRipples, vec2(ripplesCoord.x, ripplesCoord.y + delta.y)).r;
  vec3 dx = vec3(delta.x, heightX - height, 0.0);
  vec3 dy = vec3(0.0, heightY - height, delta.y);
  vec2 offset = -normalize(cross(dy, dx)).xz;
  float specular = pow(max(0.0, dot(offset, normalize(vec2(-0.6, 1.0)))), 64.0);
  gl_FragColor = texture2D(samplerBackground, backgroundCoord + offset * perturbance) + specular * 0.25;
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
    // 原库 initTexture 里有一行 gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, 1)——
    // 背景纹理必须翻转上传,render vertex shader 的 backgroundCoord.y = 1-y
    // 是按"翻转过的纹理"写的。移植时漏了这行,背景整个上下颠倒:夕阳(图的
    // 顶部)跑到海底,顶上只剩深海紫,被老婆抓到"我的夕阳呢"。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
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
    if (!this.bgTexture) return;
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
    console.error(
      `[waterRipples] 不支持或初始化失败，降级为纯焦散层: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
