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

import { debugError, debugInfo } from './debugLog';

export type RippleOptions = {
  resolution?: number; // 仿真纹理边长,默认 256(手机优先，越小越省)
  perturbance?: number; // 折射扰动强度，越大扭曲越明显
  highlight?: number; // 坡度仿高光强度，越大水面反光越明显
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
  // 耦合系数从 2.0 调低到 1.15——2D 波动方程本身就会随着波前变大、能量摊到
  // 更大周长上而自然变暗,系数越大波纹跑得越快、扩散到视野外/衰减得也越快,
  // 参考图那种"波光荡漾良久"的效果需要波跑得慢一点、多晃几下才行。
  float velocity = data.g + (average - data.r) * 1.15;
  velocity *= uDamping;
  float height = data.r + velocity;
  gl_FragColor = vec4(height, velocity, 0.0, 1.0);
}
`;

// 读旧状态 + 加凸起 + 写回(ping-pong 到另一张纹理),不靠硬件混合叠加——
// WebGL1 对浮点渲染目标做加法混合需要 EXT_float_blend 扩展，这个扩展在
// 不少手机 GPU 上并不支持，glEnable(BLEND) 会被静默忽略(不报错、不崩溃，
// 就是什么也没发生)。实测过:真机上 drop() 坐标日志一切正常、WebGL 初始化
// 成功、背景图正常渲染，但涟漪完全不出现——正是这种"混合被吃掉"的典型症状。
// 改成跟 update 通道一样的读旧值+写新值套路，不依赖任何混合扩展。
const DROP_FRAG_SRC = `
precision mediump float;
uniform sampler2D uPrevState;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uStrength;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec4 data = texture2D(uPrevState, vUv);
  // 仿真状态存在一张正方形纹理里,但它的 UV 是直接当"画布上的比例坐标"用的——
  // 手机画布是竖屏(高远大于宽),vUv 空间里的一个正圆落到画布上会被拉成竖着的
  // 椭圆。用 uAspect(画布宽/高)把 x 方向的距离先放大抵消掉,水花落下的
  // 那一下才是真正的圆,不是椭圆。
  vec2 d = vUv - uCenter;
  d.x *= uAspect;
  float dist = length(d);
  float drop = max(0.0, 1.0 - dist / uRadius);
  drop = drop * drop * (3.0 - 2.0 * drop);
  gl_FragColor = vec4(data.r + drop * uStrength, data.g, 0.0, 1.0);
}
`;

const RENDER_FRAG_SRC = `
precision mediump float;
uniform sampler2D uState;
uniform sampler2D uBackground;
uniform vec2 uDelta;
uniform vec2 uCoverScale;
uniform float uPerturbance;
uniform float uHighlight;
uniform int uDebugVisualize;
varying vec2 vUv;
void main() {
  // 临时诊断分支: 直接把高度场当灰阶/红蓝热力图画出来,完全跳过背景折射合成——
  // 只要 drop() 真的把凸起写进纹理、update() 真的在传播,不管折射合成那步
  // 有没有毛病,这里都该能看到一块明显的红色(凸起)往外扩散成红蓝相间的圈。
  // 这条路径只依赖"着色器里 texture2D 采样"这个已经确认能用的能力(render()
  // 采样背景图正常显示出来过),完全不经过 readPixels(已确认在这台设备上失败)。
  if (uDebugVisualize == 1) {
    float h = texture2D(uState, vUv).r;
    if (h >= 0.0) {
      gl_FragColor = vec4(0.5 + h * 6.0, 0.5, 0.5, 1.0);
    } else {
      gl_FragColor = vec4(0.5, 0.5, 0.5 - h * 6.0, 1.0);
    }
    return;
  }
  float hL = texture2D(uState, vUv - vec2(uDelta.x, 0.0)).r;
  float hR = texture2D(uState, vUv + vec2(uDelta.x, 0.0)).r;
  float hD = texture2D(uState, vUv - vec2(0.0, uDelta.y)).r;
  float hU = texture2D(uState, vUv + vec2(0.0, uDelta.y)).r;
  vec2 normal = vec2(hL - hR, hD - hU);
  vec2 bgUv = (vUv - 0.5) * uCoverScale + 0.5 + normal * uPerturbance;
  vec4 bg = texture2D(uBackground, clamp(bgUv, 0.001, 0.999));
  // 纯折射位移在这张软渐变背景上只有几像素,肉眼几乎看不出来(热力图已经证实
  // 数据链路本身没问题)。叠一层只会"提亮"、不会"压暗"的仿高光(水面反光的
  // 经典近似,只加不减)——这张背景本身偏亮偏柔,加暗会读成一块脏兮兮的
  // 阴影/黑影(实测过),只加亮才会读成"波光粼粼",不会有变脏的错觉。
  // 用 length(normal) 而不是 normal.x+normal.y——后者等价于跟固定方向(1,1)
  // 做点积,相当于假设了一个固定的"光源方向",导致沿(1,1)对角线最亮、
  // 沿垂直对角线直接掉到 0,一圈本该对称的涟漪就被压成"两头尖"的橄榄形
  // (实测过,真机截图上明显能看到)。改成梯度模长,不挑角度,任何方向的坡度
  // 都同样提亮,圆环才会是圆的。
  float glow = clamp(length(normal) * uHighlight, 0.0, 0.42);
  bg.rgb += glow;
  gl_FragColor = bg;
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
  private highlight: number;
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
  private canvasAspect = 1; // canvas.width / canvas.height——手机竖屏时远小于 1

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private loggedFirstRender = false; // 临时诊断: render() 真的跑起来了没有,只打一次
  private debugVisualize = false; // 临时诊断: 开启后 render() 直接画高度场热力图,不画折射背景

  constructor(canvas: HTMLCanvasElement, opts: RippleOptions = {}) {
    this.canvas = canvas;
    this.resolution = opts.resolution ?? 256;
    // 数据链路(drop→update→render 采样)已经用热力图确认没问题,"只加亮不压暗"
    // 的仿高光技术也确认能让涟漪在这张软背景上看得见——不再需要刻意调夸张的
    // 诊断值,回落到克制、耐看的观感数值(仍比最终目标稍强一档,留一点确认空间,
    // 等看着舒服了再收一收)。
    this.perturbance = opts.perturbance ?? 0.035;
    // "两头尖"那个方向性 bug 顺带也解释了"微弱"——之前一圈里有小半圈角度
    // 因为点积公式直接掉到 0,平均下来自然显弱。现在角度均匀了,系数还是
    // 顺手调高一点,确保这一轮能看清楚。
    this.highlight = opts.highlight ?? 2.6;
    this.dropRadius = opts.dropRadius ?? (20 / this.resolution);
    // damping 调高(更接近 1)配合上面波速调慢——真机反馈"圆形对了,但太快
    // 消散,截图都来不及",参考图那种水面是要能晃悠好几圈才慢慢平复的。
    this.damping = opts.damping ?? 0.997;

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
    this.canvasAspect = this.canvas.width / this.canvas.height;
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
  // 读当前状态、加凸起、写进另一张 ping-pong 纹理，不用等下一帧 rAF、
  // 也不依赖硬件混合(见 DROP_FRAG_SRC 顶部注释)——触感依然即时,
  // 下一次 step() 会从这个刚写入的状态继续演化。
  // strength 从诊断期的夸张值(0.35)收回到比最终目标(0.09)稍强一档的数值——
  // 数据链路和可见性技术都已确认没问题,不需要再刻意调夸张了。
  drop(u: number, v: number, strength = 0.16) {
    const gl = this.gl;
    const src = this.srcIsA ? this.targetA : this.targetB;
    const dst = this.srcIsA ? this.targetB : this.targetA;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.useProgram(this.dropProgram);
    this.bindQuad(this.dropProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(this.dropProgram, 'uPrevState'), 0);
    gl.uniform2f(gl.getUniformLocation(this.dropProgram, 'uCenter'), u, 1 - v);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'uRadius'), this.dropRadius);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'uStrength'), strength);
    gl.uniform1f(gl.getUniformLocation(this.dropProgram, 'uAspect'), this.canvasAspect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.srcIsA = !this.srcIsA;
  }

  // 临时诊断: 读一下"当前最新状态"纹理在某个归一化坐标点的原始字节值,
  // 用来验证 drop() 有没有真的把数据写进纹理里——比"眼睛看有没有涟漪"更
  // 直接客观,不受视觉强度/画面细节/截图压缩的干扰。
  // 用 RGBA+UNSIGNED_BYTE 读取(WebGL 规范里唯一保证任何设备、任何帧缓冲
  // 内部格式都支持的组合),数值会被裁到 0~1 再量化成 0~255——诊断"是不是
  // 非零"完全够用,不需要精确的浮点原值。
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
  // 不靠 CPU 读回(readPixels 在这台设备上已确认失败),完全靠 GPU 自己采样自己画,
  // 跟"背景图能正常显示"走的是同一条已确认可用的能力路径。
  setDebugVisualize(on: boolean) {
    this.debugVisualize = on;
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
    // deltaY 是仿真纹理自己的一格步长; deltaX 按画布宽高比放大/缩小,让 x/y
    // 两个方向的取样步长对应到画布上的物理距离一致——不然波纹在竖屏上会沿
    // 高的那个方向"跑得更快",扩散出来就是椭圆而不是圆(见 DROP_FRAG_SRC 顶部
    // 同一个问题的注释)。
    const deltaY = 1 / this.resolution;
    const deltaX = deltaY / this.canvasAspect;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.useProgram(this.updateProgram);
    this.bindQuad(this.updateProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram, 'uPrevState'), 0);
    gl.uniform2f(gl.getUniformLocation(this.updateProgram, 'uDelta'), deltaX, deltaY);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uDamping'), this.damping);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.srcIsA = !this.srcIsA;
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
    const state = this.srcIsA ? this.targetA : this.targetB;
    const deltaY = 1 / this.resolution;
    const deltaX = deltaY / this.canvasAspect;

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
    gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'uDelta'), deltaX, deltaY);
    gl.uniform2f(
      gl.getUniformLocation(this.renderProgram, 'uCoverScale'),
      this.coverScale.x,
      this.coverScale.y,
    );
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'uPerturbance'), this.perturbance);
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'uHighlight'), this.highlight);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'uDebugVisualize'), this.debugVisualize ? 1 : 0);
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
    debugError(
      `[waterRipples] 不支持或初始化失败，降级为纯焦散层: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
