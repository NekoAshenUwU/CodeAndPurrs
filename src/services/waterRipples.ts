// 落予棠海面: 自写 WebGL 水面涟漪引擎(原理跟 jquery.ripples 一致——帧缓冲高度场
// + 离散波动方程 + 法线折射采样),不依赖 jQuery/第三方库。
//
// 流程:
//   1. 256x256 的 ping-pong 纹理对存(height, velocity)两个量,每帧跑一次
//      "update" 着色器(离散波动方程 + 阻尼)推进模拟。
//   2. drop() 读旧状态 + 加凸起 + 写回另一张纹理(手指按下的水花)，
//      下一帧 update 会把这个凸起自然扩散成向外传播的波纹。
//   3. render 通道从高度场算出法线(中心差分)，用法线对背景图 UV 做小幅偏移
//      (折射) + 镜面高光,采样出扭曲/发光的背景画面画到可见 canvas 上。
//
// 仿真纹理固定用 RGBA8/UNSIGNED_BYTE——这是 WebGL1 规范里唯一保证 100% 支持
// "渲染到纹理"的格式组合,不依赖 OES_texture_half_float / OES_texture_float
// 这类扩展。之前用 half-float/float 纹理时,在某些真机上出现过"扩展存在、
// checkFramebufferStatus 也报 COMPLETE,但 readPixels 读回来永远报错、
// 热力图偶发看不到扩散"的情况——不能 100%排除是"看似支持、实际渲染不可靠"
// 这类静默失败(跟之前 EXT_float_blend 静默不生效是同一类坑)。
// height/velocity 各自编码成 16 位定点数,拆进 RGBA8 的两个通道里存
// (RG=height, BA=velocity,见 encode16/decode16),精度足够(±2.0 范围下
// 分辨率约 6e-5),换来的是任何 WebGL1 设备都不会在这一步就出问题。

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

// height/velocity 各自是一个可正可负的量,压进 RGBA8 的两个通道(每个量占
// 用两个 8 位通道,拼成 16 位定点数),±range 范围内映射到 0~65535,
// 四舍五入取整再拆高低字节——不做四舍五入的话 0 这个最常出现的值(静止水面)
// 会因为浮点误差拆不成整数字节,导致"清成静止状态"这种最基础的操作都对不上。
const PACK_GLSL = `
vec2 encode16(float v, float range) {
  float t = clamp(v / range * 0.5 + 0.5, 0.0, 1.0);
  float v16 = floor(t * 65535.0 + 0.5);
  float hi = floor(v16 / 256.0);
  float lo = v16 - hi * 256.0;
  return vec2(hi, lo) / 255.0;
}
float decode16(vec2 enc, float range) {
  float v16 = enc.x * 255.0 * 256.0 + enc.y * 255.0;
  float t = v16 / 65535.0;
  return (t - 0.5) * 2.0 * range;
}
`;

const UPDATE_FRAG_SRC = `
precision highp float;
uniform sampler2D uPrevState;
uniform vec2 uDelta;
uniform float uDamping;
varying vec2 vUv;
${PACK_GLSL}
void main() {
  vec4 data = texture2D(uPrevState, vUv);
  float height = decode16(data.rg, 2.0);
  float velocity = decode16(data.ba, 2.0);
  vec2 dx = vec2(uDelta.x, 0.0);
  vec2 dy = vec2(0.0, uDelta.y);
  float average = (
    decode16(texture2D(uPrevState, vUv - dx).rg, 2.0) +
    decode16(texture2D(uPrevState, vUv + dx).rg, 2.0) +
    decode16(texture2D(uPrevState, vUv - dy).rg, 2.0) +
    decode16(texture2D(uPrevState, vUv + dy).rg, 2.0)
  ) * 0.25;
  // 耦合系数从 2.0 调低到 1.15——2D 波动方程本身就会随着波前变大、能量摊到
  // 更大周长上而自然变暗,系数越大波纹跑得越快、扩散到视野外/衰减得也越快,
  // 参考图那种"波光荡漾良久"的效果需要波跑得慢一点、多晃几下才行。
  velocity += (average - height) * 1.15;
  velocity *= uDamping;
  height += velocity;
  gl_FragColor = vec4(encode16(height, 2.0), encode16(velocity, 2.0));
}
`;

const DROP_FRAG_SRC = `
precision highp float;
uniform sampler2D uPrevState;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uStrength;
uniform float uAspect;
varying vec2 vUv;
${PACK_GLSL}
void main() {
  vec4 data = texture2D(uPrevState, vUv);
  float height = decode16(data.rg, 2.0);
  float velocity = decode16(data.ba, 2.0);
  // 仿真状态存在一张正方形纹理里,但它的 UV 是直接当"画布上的比例坐标"用的——
  // 手机画布是竖屏(高远大于宽),vUv 空间里的一个正圆落到画布上会被拉成竖着的
  // 椭圆。用 uAspect(画布宽/高)把 x 方向的距离先放大抵消掉,水花落下的
  // 那一下才是真正的圆,不是椭圆。
  vec2 d = vUv - uCenter;
  d.x *= uAspect;
  float dist = length(d);
  float drop = max(0.0, 1.0 - dist / uRadius);
  drop = drop * drop * (3.0 - 2.0 * drop);
  height += drop * uStrength;
  gl_FragColor = vec4(encode16(height, 2.0), encode16(velocity, 2.0));
}
`;

const RENDER_FRAG_SRC = `
precision highp float;
uniform sampler2D uState;
uniform sampler2D uBackground;
uniform vec2 uDelta;
uniform vec2 uCoverScale;
uniform float uPerturbance;
uniform float uHighlight;
uniform int uDebugVisualize;
varying vec2 vUv;
${PACK_GLSL}
void main() {
  // 临时诊断分支: 直接把高度场当灰阶/红蓝热力图画出来,完全跳过背景折射合成——
  // 只要 drop() 真的把凸起写进纹理、update() 真的在传播,不管折射合成那步
  // 有没有毛病,这里都该能看到一块明显的红色(凸起)往外扩散成红蓝相间的圈。
  if (uDebugVisualize == 1) {
    float h = decode16(texture2D(uState, vUv).rg, 2.0);
    if (h >= 0.0) {
      gl_FragColor = vec4(0.5 + h * 6.0, 0.5, 0.5, 1.0);
    } else {
      gl_FragColor = vec4(0.5, 0.5, 0.5 - h * 6.0, 1.0);
    }
    return;
  }
  float hL = decode16(texture2D(uState, vUv - vec2(uDelta.x, 0.0)).rg, 2.0);
  float hR = decode16(texture2D(uState, vUv + vec2(uDelta.x, 0.0)).rg, 2.0);
  float hD = decode16(texture2D(uState, vUv - vec2(0.0, uDelta.y)).rg, 2.0);
  float hU = decode16(texture2D(uState, vUv + vec2(0.0, uDelta.y)).rg, 2.0);
  vec2 normal = vec2(hL - hR, hD - hU);
  // 折射位移是主视觉:用高度场的梯度偏移背景纹理采样 UV,让波纹"推开又复原"
  // 背景本身的画面细节,这才是"水在动"的观感来源。之前主视觉是镜面高光
  // (法线点积固定光源),读起来是"一闪一闪的光斑快速消散",不是水纹本身
  // 在扭曲——现在数据链路已经用热力图+真实高度读数完全验证过没问题
  // (读数在 0.13 左右,量级正常),可以放心把 uPerturbance 调大到能看出
  // 明显扭曲的程度,不用再顾虑"是不是白费力气调一个还没验证过的效果"。
  vec2 bgUv = (vUv - 0.5) * uCoverScale + 0.5 + normal * uPerturbance;
  vec4 bg = texture2D(uBackground, clamp(bgUv, 0.001, 0.999));
  // 高光只做辅助,不做主视觉:改回各向同性的梯度模长提亮(不挑角度、不用
  // 点积镜面高光那套),系数和上限都调得很小,只是给波纹边缘加一点点
  // "反光感",视觉重心必须在上面的折射扭曲上。
  float highlight = clamp(length(normal) * uHighlight, 0.0, 0.12);
  bg.rgb += highlight;
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
// 固定用 RGBA8/UNSIGNED_BYTE,这是 WebGL1 规范里唯一保证任何设备都支持
// "渲染到纹理"的格式,不依赖任何扩展,也就不存在"扩展看似存在、实际渲染
// 不可靠"这类静默失败的可能。
function createRenderableTarget(gl: WebGLRenderingContext, size: number): SimTarget | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

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
    // 数据链路现在已经用热力图+真实高度读数完全验证过没问题(读数 ~0.13,
    // 量级正常),折射改回主视觉,可以放心调大——不再是"调了也不知道有没有
    // 用"的阶段。
    this.perturbance = opts.perturbance ?? 0.6;
    // 高光只做辅助提亮,系数调小很多(配合 RENDER_FRAG_SRC 里改回的各向同性
    // 梯度模长提亮,不再是主视觉)。
    this.highlight = opts.highlight ?? 1.0;
    this.dropRadius = opts.dropRadius ?? (20 / this.resolution);
    // damping 保持在接近 1 的一档,让单次点击的波多晃几圈再衰减完。
    this.damping = opts.damping ?? 0.998;

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

    // encode16/decode16 要把 0~65535 的整数原样存进/读出浮点数——这需要至少
    // ~17 位有效精度。fragment shader 默认精度声明 mediump 在不少手机 GPU 上
    // 实际就是 IEEE 半精度浮点(约 10 位尾数),连 2048 以上的整数都存不准,
    // 高度编码在这种精度下会被悄悄舍入成错误值(实测过:真机上读回的高度
    // 永远卡在编码范围的下限,不管有没有真的点过水面——就是这个精度坑)。
    // 换成 highp 需要 GPU 支持,虽然 WebGL1 规范只是"建议"fragment shader
    // 支持 highp、不强制,但绝大多数这十年内的手机 GPU 都支持——这里用
    // getShaderPrecisionFormat 实测查一下，不支持就明确报错降级，而不是
    // 沉默地算出错误数字。
    const highpInfo = gl.getShaderPrecisionFormat?.(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!highpInfo || highpInfo.precision === 0) {
      throw new Error('设备 fragment shader 不支持 highp 精度,涟漪的高度编码需要更高精度,无法运行');
    }

    // RGBA8 是 WebGL1 规范里唯一保证任何设备都能"渲染到纹理"的格式,不依赖
    // 任何扩展——理论上这里不该失败,除非 WebGL 上下文本身有问题。
    const target = createRenderableTarget(gl, this.resolution);
    if (!target) throw new Error('设备不支持渲染到纹理，涟漪不可用');
    this.targetA = target;
    const targetB = createRenderableTarget(gl, this.resolution);
    if (!targetB) throw new Error('第二个 ping-pong 纹理创建失败');
    this.targetB = targetB;

    // texImage2D(..., null) 只分配显存,内容按 WebGL 规范是未定义的(不保证是 0)——
    // 实测过不清零会导致水面从第一帧就带着满屏"噪声波纹"，而不是静止的水面。
    // height/velocity 现在编码进 RGBA8 的两个定点数(见 PACK_GLSL),"0" 不再是
    // 裸的 (0,0,0,0)——按 encode16(0, 2.0) 算出来,静止状态对应 (128,0,128,0)/255。
    for (const t of [this.targetA, this.targetB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
      gl.viewport(0, 0, this.resolution, this.resolution);
      gl.clearColor(128 / 255, 0, 128 / 255, 0);
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

  // 诊断: 读一下"当前最新状态"纹理在某个归一化坐标点的真实高度值,
  // 用来验证 drop() 有没有真的把数据写进纹理里——比"眼睛看有没有涟漪"更
  // 直接客观,不受视觉强度/画面细节/截图压缩的干扰。
  // 现在仿真纹理固定是 RGBA8/UNSIGNED_BYTE(见文件顶部注释),readPixels 用
  // RGBA+UNSIGNED_BYTE 读取是 WebGL 规范保证任何设备都支持的组合,不应该
  // 再报错——之前用 half-float/float 纹理时这里会报错返回 null,换成 RGBA8
  // 之后如果还是 null,说明问题比"纹理格式不支持读回"更底层。
  // 读到的 R,G 两个字节按 encode16 的逆运算解出真实高度(不再是裸字节值)。
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
    const v16 = pixel[0] * 256 + pixel[1];
    const t = v16 / 65535;
    return (t - 0.5) * 2 * 2.0;
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
    // 仿真纹理本身就是正方形存储(256x256),这里只是在读它自己格子里的邻居——
    // 必须用对称步长(dx=dy=1/resolution)。之前在这里也套了宽高比校正,
    // 结果在 NEAREST 采样下变成非整数格偏移(比如 x 方向偏移到 1.86 格,
    // 取整变 2 格,y 方向还是 1 格),每帧都在递归的波动方程里累积这个方向性
    // 偏差,晃几圈之后就演化成一圈"漩涡"而不是同心圆——回退成对称步长,
    // 画布宽高比的修正只在"种子形状"(DROP_FRAG_SRC 的 uAspect)这个
    // 一次性、不递归的地方做,不会累积出问题。
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
    // 跟 step() 同理: 读的是同一张正方形仿真纹理自己的邻居格子,对称步长就好,
    // 不需要(也不该)套宽高比。
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
