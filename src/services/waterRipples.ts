// 落予棠海面: 自写 WebGL 水面涟漪引擎(原理跟 jquery.ripples 一致——帧缓冲高度场
// + 离散波动方程 + 法线折射采样),不依赖 jQuery/第三方库。
//
// 流程:
//   1. 256x256 的 ping-pong 纹理对存(height, velocity)两个通道,每帧跑一次
//      "update" 着色器(离散波动方程 + 阻尼)推进模拟。
//   2. drop() 用叠加混合(ONE,ONE)往当前纹理里加一个平滑凸起(手指按下的水花)，
//      下一帧 update 会把这个凸起自然扩散成向外传播的波纹。
//   3. render 通道从高度场算出法线(中心差分)，用法线对背景图 UV 做小幅偏移
//      (折射),采样出扭曲的背景画面画到可见 canvas 上。
//
// 只用 NEAREST 采样(不需要 *_linear 扩展)、只需要 half-float 或 float 纹理
// 中的一种支持渲染到帧缓冲——用真实创建+挂载+checkFramebufferStatus 验证，
// 而不是只看扩展字符串存不存在(某些设备扩展在但实际渲染不到该纹理格式)。
// 任何一步失败都在构造期抛出,调用方 catch 到就整体退化(参见 createWaterRipples)。

export type RippleOptions = {
  resolution?: number; // 仿真纹理边长,默认 256(手机优先，越小越省)
  perturbance?: number; // 折射扰动强度，越大扭曲越明显
  dropRadius?: number; // 涟漪半径，仿真纹理空间的归一化值(0~1)
  damping?: number; // 波动衰减系数，越接近 1 波纹持续越久
};

const VERTEX_SRC = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const UPDATE_FRAG_SRC = `
precision mediump float;
uniform sampler2D uPrevState;
uniform vec2 uDelta;
uniform float uDamping;
varying vec2 vUv;
void main() {
  vec4 data = texture2D(uPrevState, vUv);
  vec2 dx = vec2(uDelta.x, 0.0);
  vec2 dy = vec2(0.0, uDelta.y);
  float average = (
    texture2D(uPrevState, vUv - dx).r +
    texture2D(uPrevState, vUv + dx).r +
    texture2D(uPrevState, vUv - dy).r +
    texture2D(uPrevState, vUv + dy).r
  ) * 0.25;
  float velocity = data.g + (average - data.r) * 2.0;
  velocity *= uDamping;
  float height = data.r + velocity;
  gl_FragColor = vec4(height, velocity, 0.0, 1.0);
}
`;

// 纯加法:输出的凸起量靠 gl.blendFunc(ONE, ONE) 叠到当前高度场上,
// G/B/A 通道写 0 不影响已有速度分量。
const DROP_FRAG_SRC = `
precision mediump float;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uStrength;
varying vec2 vUv;
void main() {
  float dist = length(vUv - uCenter);
  float drop = max(0.0, 1.0 - dist / uRadius);
  drop = drop * drop * (3.0 - 2.0 * drop);
  gl_FragColor = vec4(drop * uStrength, 0.0, 0.0, 0.0);
}
`;

const RENDER_FRAG_SRC = `
precision mediump float;
uniform sampler2D uState;
uniform sampler2D uBackground;
uniform vec2 uDelta;
uniform vec2 uCoverScale;
uniform float uPerturbance;
varying vec2 vUv;
void main() {
  float hL = texture2D(uState, vUv - vec2(uDelta.x, 0.0)).r;
  float hR = texture2D(uState, vUv + vec2(uDelta.x, 0.0)).r;
  float hD = texture2D(uState, vUv - vec2(0.0, uDelta.y)).r;
  float hU = texture2D(uState, vUv + vec2(0.0, uDelta.y)).r;
  vec2 normal = vec2(hL - hR, hD - hU);
  vec2 bgUv = (vUv - 0.5) * uCoverScale + 0.5 + normal * uPerturbance;
  gl_FragColor = texture2D(uBackground, clamp(bgUv, 0.001, 0.999));
}
`;

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

// 真正尝试创建一个"能渲染到"的纹理+FBO，用 checkFramebufferStatus 验证——
// 扩展存在不代表这个纹理格式真能当渲染目标用，必须实测。
function createRenderableTarget(
  gl: WebGLRenderingContext,
  size: number,
  type: number,
): SimTarget | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
  private perturbance: number;
  private dropRadius: number;
  private damping: number;

  private quadBuffer: WebGLBuffer;
  private updateProgram: WebGLProgram;
  private dropProgram: WebGLProgram;
  private renderProgram: WebGLProgram;

  private simDataType: number;
  private targetA: SimTarget;
  private targetB: SimTarget;
  private srcIsA = true; // 当前"最新状态"在 A 还是 B

  private bgTexture: WebGLTexture | null = null;
  private bgImageSize = { w: 1, h: 1 };
  private coverScale = { x: 1, y: 1 };

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, opts: RippleOptions = {}) {
    this.canvas = canvas;
    this.resolution = opts.resolution ?? 256;
    this.perturbance = opts.perturbance ?? 0.025;
    this.dropRadius = opts.dropRadius ?? (20 / this.resolution);
    this.damping = opts.damping ?? 0.988;

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

    // half-float 优先(精度够、更省)，不行退 float；两个都不能渲染就彻底不支持。
    const halfFloatExt = gl.getExtension('OES_texture_half_float');
    let dataType: number | null = null;
    let target = halfFloatExt
      ? createRenderableTarget(gl, this.resolution, halfFloatExt.HALF_FLOAT_OES)
      : null;
    if (target) dataType = halfFloatExt!.HALF_FLOAT_OES;
    if (!target) {
      const floatExt = gl.getExtension('OES_texture_float');
      target = floatExt ? createRenderableTarget(gl, this.resolution, gl.FLOAT) : null;
      if (target) dataType = gl.FLOAT;
    }
    if (!target || dataType === null) throw new Error('设备不支持渲染到浮点纹理，涟漪不可用');
    this.simDataType = dataType;
    this.targetA = target;
    const targetB = createRenderableTarget(gl, this.resolution, dataType);
    if (!targetB) throw new Error('第二个 ping-pong 纹理创建失败');
    this.targetB = targetB;

    // texImage2D(..., null) 只分配显存,内容按 WebGL 规范是未定义的(不保证是 0)——
    // 实测过不清零会导致水面从第一帧就带着满屏"噪声波纹"，而不是静止的水面。
    // 显式清成 (0,0,0,0)：height=0、velocity=0，水面在没人碰之前必须是静止的。
    for (const t of [this.targetA, this.targetB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
      gl.viewport(0, 0, this.resolution, this.resolution);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.updateProgram = linkProgram(gl, VERTEX_SRC, UPDATE_FRAG_SRC);
    this.dropProgram = linkProgram(gl, VERTEX_SRC, DROP_FRAG_SRC);
    this.renderProgram = linkProgram(gl, VERTEX_SRC, RENDER_FRAG_SRC);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  // 背景图跟其它房间一样走 background-size:cover 的裁切逻辑，算出采样窗口比例。
  private updateCoverScale() {
    const canvasAspect = this.canvas.width / this.canvas.height;
    const imageAspect = this.bgImageSize.w / this.bgImageSize.h;
    this.coverScale = {
      x: Math.min(1, canvasAspect / imageAspect),
      y: Math.min(1, imageAspect / canvasAspect),
    };
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.updateCoverScale();
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.bgTexture = texture;
    this.updateCoverScale();
  }

  // 手指/鼠标在归一化坐标(0~1，画布局部)按下的位置起一圈涟漪。
  // 直接对"当前最新状态"纹理做叠加渲染，不用等下一帧 rAF，触感更即时。
  drop(u: number, v: number, strength = 0.09) {
    const gl = this.gl;
    const cur = this.srcIsA ? this.targetA : this.targetB;
    gl.bindFramebuffer(gl.FRAMEBUFFER, cur.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.useProgram(this.dropProgram);
    this.bindQuad(this.dropProgram);
    gl.uniform2f(gl.getUniformLocation(this.dropProgram, 'uCenter'), u, 1 - v);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'uRadius'), this.dropRadius);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'uStrength'), strength);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private bindQuad(program: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const loc = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private step() {
    const gl = this.gl;
    const src = this.srcIsA ? this.targetA : this.targetB;
    const dst = this.srcIsA ? this.targetB : this.targetA;
    const delta = 1 / this.resolution;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.useProgram(this.updateProgram);
    this.bindQuad(this.updateProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram, 'uPrevState'), 0);
    gl.uniform2f(gl.getUniformLocation(this.updateProgram, 'uDelta'), delta, delta);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uDamping'), this.damping);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.srcIsA = !this.srcIsA;
  }

  private render() {
    const gl = this.gl;
    if (!this.bgTexture) return;
    const state = this.srcIsA ? this.targetA : this.targetB;
    const delta = 1 / this.resolution;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.renderProgram);
    this.bindQuad(this.renderProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'uState'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTexture);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'uBackground'), 1);
    gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'uDelta'), delta, delta);
    gl.uniform2f(
      gl.getUniformLocation(this.renderProgram, 'uCoverScale'),
      this.coverScale.x,
      this.coverScale.y,
    );
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'uPerturbance'), this.perturbance);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  start() {
    if (this.rafId !== null) return;
    const loop = () => {
      if (this.destroyed) return;
      this.step();
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
    gl.deleteProgram(this.updateProgram);
    gl.deleteProgram(this.dropProgram);
    gl.deleteProgram(this.renderProgram);
    gl.deleteFramebuffer(this.targetA.framebuffer);
    gl.deleteTexture(this.targetA.texture);
    gl.deleteFramebuffer(this.targetB.framebuffer);
    gl.deleteTexture(this.targetB.texture);
    if (this.bgTexture) gl.deleteTexture(this.bgTexture);
  }
}

// 供 React 组件调用的安全入口:构造+加载图片全程 try/catch，任何一步失败
// (WebGL 不可用/扩展缺失/渲染到浮点纹理不支持/图片加载失败)都返回 null，
// 调用方据此走"只保留焦散层，涟漪关闭"的降级路径。
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
    console.warn('[waterRipples] 不支持或初始化失败，降级为纯焦散层:', err);
    return null;
  }
}
