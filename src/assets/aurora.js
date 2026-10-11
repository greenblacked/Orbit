/* Aurora: a small WebGL canvas behind the hero, six slow blobs of light in the six family
   accents. It is its own module, imported by fx.js only after the page has painted and only
   where a cheap device can carry it. It draws at a quarter of the hero's size and lets the CSS
   scale it up (the glow is blurry by nature), renders only while the hero is on screen, stops
   while the tab is hidden, and gives itself up, putting the CSS gradient fallback back, when the
   context is lost or when the frames in its first second take longer than 20 ms on average. */
const VERTEX = "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";
const FRAGMENT = [
  "precision mediump float;",
  "uniform vec2 r;uniform float t;uniform float k;uniform vec3 c[6];",
  "void main(){",
  "  vec2 q=gl_FragCoord.xy/r.y;",
  "  float w=0.0;vec3 col=vec3(0.0);",
  "  for(int i=0;i<6;i++){",
  "    float f=float(i);",
  "    vec2 m=vec2(r.x/r.y*(0.5+0.46*sin(t*0.09+f*1.9)),0.55+0.32*cos(t*0.07+f*2.4));",
  "    float d=distance(q,m);",
  "    float a=exp(-d*d*7.0);",
  "    col+=c[i]*a;w+=a;",
  "  }",
  "  float alpha=clamp(w*0.5,0.0,1.0)*k;",
  "  gl_FragColor=vec4(col/max(w,0.001)*alpha,alpha);",
  "}"
].join("\n");

const FALLBACK = ["#d7452f", "#a36f14", "#288b35", "#158591", "#7869d9", "#cc3fa1"];
const PROBE_MS = 1000;
const MAX_FRAME_MS = 20;
const SCALE = 4;

function rgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0.5, 0.5, 0.5];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

// Start the aurora in host (the .aurora element). Resolves to true when it is running, false when
// the device cannot or should not run it; in the second case nothing has been added to the page.
export default function start(host, colors) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return Promise.resolve(false);
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return Promise.resolve(false);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return Promise.resolve(false);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const size = gl.getUniformLocation(program, "r");
  const time = gl.getUniformLocation(program, "t");
  const strength = gl.getUniformLocation(program, "k");
  const palette = [];
  for (let i = 0; i < 6; i++) palette.push(...rgb((colors && colors[i]) || FALLBACK[i]));
  gl.uniform3fv(gl.getUniformLocation(program, "c"), new Float32Array(palette));

  const readStrength = () => {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--aurora"));
    gl.uniform1f(strength, Number.isFinite(value) ? Math.min(1, value * 1.6) : 0.4);
  };
  const resize = () => {
    canvas.width = Math.max(32, Math.ceil(host.clientWidth / SCALE));
    canvas.height = Math.max(32, Math.ceil(host.clientHeight / SCALE));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(size, canvas.width, canvas.height);
  };

  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "aurora-gl";
  resize();
  readStrength();
  host.insertBefore(canvas, host.firstChild);
  host.classList.add("gl");

  let visible = true;
  let frame = 0;
  let begin = 0;
  let previous = 0;
  let frames = 0;
  let spent = 0;
  let probing = true;
  let stopped = false;

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    themes.disconnect();
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("resize", resize);
    host.classList.remove("gl");
    canvas.remove();
  };
  const loop = (now) => {
    frame = 0;
    if (stopped || !visible || document.hidden) return;
    if (!begin) begin = now;
    if (probing && previous) {
      frames++;
      // The first frames pay for the shader compile; the verdict counts the rest.
      if (frames > 4) spent += now - previous;
      if (now - begin >= PROBE_MS) {
        probing = false;
        if (frames > 5 && spent / (frames - 4) > MAX_FRAME_MS) { stop(); return; }
      }
    }
    previous = now;
    gl.uniform1f(time, (now - begin) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frame = requestAnimationFrame(loop);
  };
  const wake = () => {
    previous = 0;
    if (!frame && !stopped && visible && !document.hidden) frame = requestAnimationFrame(loop);
  };

  // Render only while the hero is on screen and the tab is shown.
  const observer = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) wake();
  });
  observer.observe(host);
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("resize", resize, { passive: true });
  // A theme change changes how strong the glow is.
  const themes = new MutationObserver(readStrength);
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); });
  wake();
  return Promise.resolve(true);
}
