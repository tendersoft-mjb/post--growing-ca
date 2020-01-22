/**
 * @fileoverview Description of this file.
 */


const vs_code = `
    attribute vec4 position;
    varying vec2 uv;
    void main() {
        uv = position.xy*0.5 + 0.5;
        gl_Position = position;
    }
`
const TENSOR_FIELDS = `
    vec2 size;
    vec2 gridSize;
    float depth, depth4;
    vec2 packScaleBias;`;

const PREFIX = `
    precision highp float;

    struct BufferInfo {
        ${TENSOR_FIELDS}
    };
    struct InputInfo {
        ${TENSOR_FIELDS}
        sampler2D tex;
    };

    uniform BufferInfo u_output;

    vec2 getOutputXY() {
        return mod(gl_FragCoord.xy, u_output.size);
    }
    float getOutputChannel() {
        vec2 xy = floor(gl_FragCoord.xy/u_output.size);
        return xy.y*u_output.gridSize.x+xy.x;
    }

    const float c = 127.0/255.0;
    void setOutput(vec4 v) {
        vec2 p = u_output.packScaleBias;
        v = atan(v)/p.x + p.y;
        gl_FragColor = v;
    }

    vec4 readTensorUV(InputInfo tensor, vec2 uv) {
        vec4 v = texture2D(tensor.tex, uv);
        vec2 p = tensor.packScaleBias;
        v = tan((v-p.y)*p.x);
        return v;
    }

    vec4 readTensor(InputInfo tensor, vec2 pos, float ch) {
        vec2 p = pos/tensor.size;
        ch += 0.5;
        float tx = floor(mod(ch, tensor.gridSize.x));
        float ty = floor(ch / tensor.gridSize.x);
        p += vec2(tx, ty);
        return readTensorUV(tensor, p/tensor.gridSize);
    }
`;

const PROGRAMS = {
    paint: `
    uniform vec2 u_pos;
    uniform float u_r;
    uniform float u_brush;

    void main() {
        vec2 xy = getOutputXY();
        if (length(xy-u_pos+0.5)>=u_r) 
          discard;
        vec4 result = vec4(0.0);
        if (u_brush>0.5) {
            float ch = getOutputChannel();
            result = vec4(vec3(float(ch>0.5)), 1.0);
        }
        setOutput(result);
    }`,
    perception: `
    uniform InputInfo u_input;

    void main() {
        vec2 xy = getOutputXY();
        float ch = getOutputChannel();
        float filterIdx = floor(ch/u_input.depth4);
        float inputCh = mod(ch, u_input.depth4);
        if (filterIdx == 0.0) {
            setOutput(readTensor(u_input, xy, inputCh));
        } else {
            vec2 dx = (filterIdx == 1.0) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            vec2 dy = vec2(dx.y, dx.x);
            vec4 v = (readTensor(u_input, xy+dx, inputCh)-readTensor(u_input, xy-dx, inputCh))*2.0+
                    readTensor(u_input, xy+dx+dy, inputCh)-readTensor(u_input, xy-dx+dy, inputCh)+
                    readTensor(u_input, xy+dx-dy, inputCh)-readTensor(u_input, xy-dx-dy, inputCh);
            setOutput(v / 8.0);
        }
    }`,
    dense: `
    uniform InputInfo u_input;
    uniform sampler2D u_weightTex;
    
    const float MAX_PACKED_DEPTH = 32.0;
    
    vec4 readWeight(vec2 p) {
        vec4 w = texture2D(u_weightTex, p);
        return log(-w/(w-1.0))/3.0;
    }
    
    void main() {
      vec2 xy = getOutputXY();
      float ch = getOutputChannel();
      if (ch >= u_output.depth4)
          return;
    
      float dy = 1.0/(u_input.depth+1.0);
      vec2 p = vec2((ch+0.5)/u_output.depth4, dy*0.5);
      vec4 result = vec4(0.0);
      for (float i=0.0; i < MAX_PACKED_DEPTH; i+=1.0) {
          vec4 inVec = readTensor(u_input, xy, i);
          result += inVec.x * readWeight(p); p.y += dy;
          result += inVec.y * readWeight(p); p.y += dy;
          result += inVec.z * readWeight(p); p.y += dy;
          result += inVec.w * readWeight(p); p.y += dy;
          if (i+1.5>u_input.depth4) {
              break;
          }
      }
      result += readWeight(p);  // bias
      setOutput(result);
    }`,
    dropout: `
    uniform InputInfo u_input;
    uniform float u_seed, u_udpateProbability;
    varying vec2 uv;
    
    // "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW)
    float hash13(vec3 p3) {
      p3  = fract(p3 * .1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    
    void main() {
      vec2 xy = getOutputXY();
      vec4 result = readTensorUV(u_input, uv);
      result *=  float(hash13(vec3(xy, u_seed)) <= u_udpateProbability);
      setOutput(result);
    }`,
    update: `
    uniform InputInfo u_state;
    uniform InputInfo u_update;
    varying vec2 uv;
    
    void main() {
      vec2 xy = getOutputXY();
      vec2 sxy = u_output.size-xy;
      float edge = min(min(xy.x, xy.y), min(sxy.x, sxy.y));
      if (edge < 1.0) {
          setOutput(vec4(0.0));
          return;
      }
      float preMaxAlpha=0.0, postMaxAlpha=0.0;
      for (float y=-1.0; y<=1.0; ++y)
      for (float x=-1.0; x<=1.0; ++x) {
          float preAlpha = readTensor(u_state, xy+vec2(x, y), 0.0).a;
          float updateAlpha = readTensor(u_update, xy+vec2(x, y), 0.0).a;
          float postAlpha = preAlpha+updateAlpha;
          preMaxAlpha = max(preAlpha, preMaxAlpha);
          postMaxAlpha = max(postAlpha, postMaxAlpha);
      }
      if (min(preMaxAlpha, postMaxAlpha) < 0.1) {
          setOutput(vec4(0.0));
          return;
      }
      vec4 state = readTensorUV(u_state, uv);
      vec4 update = readTensorUV(u_update, uv);
      setOutput(state + update);
    }`,
    vis: `
    uniform InputInfo u_input;
    uniform float u_raw;
    varying vec2 uv;
    void main() {
        vec2 xy = vec2(uv.x, 1.0-uv.y);
        if (u_raw > 0.5) {
            gl_FragColor = texture2D(u_input.tex, xy);
            gl_FragColor.a = 1.0;
        } else {
            xy *= u_input.size;    
            vec4 rgba = readTensor(u_input, xy, 0.0);
            gl_FragColor = 1.0-rgba.a + rgba;
        }
    }`
}

function decodeArray(s, arrayType) {
    const data = atob(s);
    const buf = new Uint8Array(data.length);
    for (var i=0; i<data.length; ++i) {
        buf[i] = data.charCodeAt(i);
    }
    return new arrayType(buf.buffer);
}


export function createDemo(gl, layerWeights) {
    function createPrograms() {
        const res = {};
        for (const name in PROGRAMS) {
            const fs_code = PREFIX + PROGRAMS[name];
            res[name] = twgl.createProgramInfo(gl, [vs_code, fs_code]);
        }
        return res;
    }

    function createTensor(h, w, depth, activation) {
        const depth4 = Math.ceil(depth / 4);
        const gridW = Math.ceil(Math.sqrt(depth4));
        const gridH = Math.floor((depth4 + gridW - 1) / gridW);
        const texW = w * gridW, texH = h * gridH;

        const attachments = [{ minMag: gl.NEAREST }];
        const fbi = twgl.createFramebufferInfo(gl, attachments, texW, texH);
        const tex = fbi.attachments[0];
        let packScaleBias = [Math.PI, 127.0/255.0];
        if (activation == 'relu') {
            packScaleBias = [Math.PI/2, 0.0];
        }
        return { _type: 'tensor',
            fbi, w, h, depth, gridW, gridH, depth4, tex,
            activation, packScaleBias};
    }

    function setTensorUniforms(uniforms, name, tensor) {
        uniforms[name + '.size'] = [tensor.w, tensor.h];
        uniforms[name + '.gridSize'] = [tensor.gridW, tensor.gridH];
        uniforms[name + '.depth'] = tensor.depth;
        uniforms[name + '.depth4'] = tensor.depth4;
        uniforms[name + '.packScaleBias'] = tensor.packScaleBias;
        if (name != 'u_output') {
            uniforms[name + '.tex'] = tensor.tex;
        }
    }

    function runLayer(programName, output, inputs) {
        inputs = inputs || {};
        const uniforms = {};
        for (const name in inputs) {
            const val = inputs[name];
            if (val._type == 'tensor') {
                setTensorUniforms(uniforms, name, val);
            } else {
                uniforms[name] = val;
            }
        }
        setTensorUniforms(uniforms, 'u_output', output);

        const program = progs[programName];
        twgl.bindFramebufferInfo(gl, output.fbi);
        gl.useProgram(program.program);
        twgl.setBuffersAndAttributes(gl, program, quad);
        twgl.setUniforms(program, uniforms);
        twgl.drawBufferInfo(gl, quad);
        return {programName, output}
    }

    function createDenseTexture(params) {
        const src = params.data || decodeArray(params.data_b64, Uint8Array);
        return twgl.createTexture(gl, {
            minMag: gl.NEAREST,
            width: params.out_ch / 4, height: params.in_ch + 1, src: src
        });
    }

    const progs = createPrograms();
    const quad = twgl.createBufferInfoFromArrays(gl, {
        position: [-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0],
    });
    

    const CHANNEL_N = 16;
    const w = 128, h = 128;
    let stateBuf = createTensor(h, w, CHANNEL_N);
    let newStateBuf = createTensor(h, w, CHANNEL_N);
    const perceptionBuf = createTensor(h, w, CHANNEL_N*3);
    const hiddenBuf = createTensor(h, w, 128, 'relu');
    const updateBuf = createTensor(h, w, CHANNEL_N);
    const maskedUpdateBuf = createTensor(h, w, CHANNEL_N);
    
    let layerTex1 = createDenseTexture(layerWeights[0]);
    let layerTex2 = createDenseTexture(layerWeights[1]);

    const ops = [
        ()=>runLayer('perception', perceptionBuf, {'u_input': stateBuf}),
        ()=>runLayer('dense', hiddenBuf, {'u_input': perceptionBuf, u_weightTex: layerTex1}),
        ()=>runLayer('dense', updateBuf, {'u_input': hiddenBuf, u_weightTex: layerTex2}),
        ()=>runLayer('dropout', maskedUpdateBuf, {'u_input': updateBuf, 'u_seed': Math.random()*1000, 'u_udpateProbability': 0.5}),
        ()=>runLayer('update', newStateBuf, {'u_state': stateBuf, 'u_update': maskedUpdateBuf}),
    ];

    reset();

    function paint(x, y, r, brush) {
        runLayer('paint', stateBuf, {
            u_pos: [x, y], u_r: r,
            u_brush: {clear: 0.0, seed: 1.0}[brush],
        });
    }

    function reset() {
        paint(0, 0, w+h, 'clear');
        paint(w/2, h/2, 1, 'seed');
    }

    function step() {
        for (const op of ops) op();
        [stateBuf, newStateBuf] = [newStateBuf, stateBuf]
    }

    const visModes = ['color', 'state', 'perception', 'hidden', 'update', 'maskedUpdate'];

    function draw(visMode) {
        visMode = visMode || 'color';
        gl.useProgram(progs.vis.program);
        twgl.setBuffersAndAttributes(gl, progs.vis, quad);
        const uniforms = {u_raw: 0.0}
        let inputBuf = stateBuf;
        if (visMode != 'color') {
            inputBuf = {stateBuf, perceptionBuf, hiddenBuf, updateBuf, maskedUpdateBuf}[visMode+'Buf'];
            uniforms.u_raw = 1.0;
        }
        setTensorUniforms(uniforms, 'u_input', inputBuf);
        twgl.setUniforms(progs.vis, uniforms);
        twgl.drawBufferInfo(gl, quad);
    }

    function setWeights(layerWeights) {
        gl.deleteTexture(layerTex1);
        gl.deleteTexture(layerTex2);
        layerTex1 = createDenseTexture(layerWeights[0]);
        layerTex2 = createDenseTexture(layerWeights[1]);
    }

    const _flushBuf = new Uint8Array(4);
    function flush(buf) {
        buf = buf || stateBuf;
        // gl.flush/finish don't seem to do anything, so reading a single 
        // pixel from the state buffer to flush the GPU command pipeline
        twgl.bindFramebufferInfo(gl, buf.fbi);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _flushBuf);
    }

    function benchmark() {
        const stepN = 100;
        const start = Date.now();
        for (let i = 0; i < stepN; ++i)
          step();
        flush();
        const total = (Date.now()-start) / stepN;

        const perOp = [];
        for (const op of ops) {
            const start = Date.now();
            let r;
            for (let i = 0; i < stepN; ++i) {
                r = op();
            }
            flush(r.output);
            const dt = (Date.now()-start) / stepN;
            const percent = 100.0*dt/total;
            perOp.push(`${r.programName}: ${percent.toFixed(1)}%`);
        }
        return `${(total).toFixed(2)} ms/step, ${(1000.0 / total).toFixed(2)} step/sec\n` +
            perOp.join(', ')+'\n\n';
    
    }

    return {reset, step, draw, benchmark, setWeights, paint, visModes};
}
