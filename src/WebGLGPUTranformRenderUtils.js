// @flow

import * as mat4 from 'gl-matrix/mat4';
import type {RenderableTrace, Measure, Extents, Layout} from './renderUtils';
import {getLayout, UtilsWithCache} from './renderUtils';
import memoizeWeak from './memoizeWeak';
import type {WebGLRenderState} from './WebGLRenderState';
import {getRandomColor, getColorForMeasure} from './WebGLColorUtils';
import {PX_PER_MS} from './constants';

// this renderer builds arrays of vertices and vertex colors once and then
// just applies a transform matrix each render
//
const vsSource = `
    attribute vec4 aVertexPosition;
    attribute vec4 aVertexColor;

    uniform mat4 uModelViewMatrix;
    uniform mat4 uProjectionMatrix;

    varying lowp vec4 vColor;

    void main(void) {
      gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
      vColor = aVertexColor;
    }
  `;

const fsSource = `
    varying lowp vec4 vColor;

    void main(void) {
      gl_FragColor = vColor;
    }
  `;

//
// Initialize a shader program, so WebGL knows how to draw our data
//
function initShaderProgram(gl, vsSource, fsSource) {
  const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

  // Create the shader program

  const shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertexShader);
  gl.attachShader(shaderProgram, fragmentShader);
  gl.linkProgram(shaderProgram);

  // If creating the shader program failed, alert

  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    throw new Error(
      'Unable to initialize the shader program: ' +
        (gl.getProgramInfoLog(shaderProgram) || '')
    );
  }

  return shaderProgram;
}

//
// creates a shader of the given type, uploads the source and
// compiles it.
//
function loadShader(gl, type, source) {
  const shader = gl.createShader(type);

  // Send the source to the shader object

  gl.shaderSource(shader, source);

  // Compile the shader program

  gl.compileShader(shader);

  // See if it compiled successfully

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(
      'An error occurred compiling the shaders: ' +
        (gl.getShaderInfoLog(shader) || '')
    );
  }

  return shader;
}

const SQUARE_VERTICES = 4; // square
function initBuffers(gl, state, programInfo) {
  const positions = [];
  const colors = [];

  let positionLength = 0;

  // init vertices using some zoom+center that we can use as the basis for
  // view transforms later
  const defaultLayoutState = {
    center: state.defaultCenter,
    viewportWidth: state.viewportWidth,
    viewportHeight: state.viewportHeight,
    zoom: state.defaultZoom,
  };
  for (let i = 0; i < state.renderableTrace.length; i++) {
    const measure = state.renderableTrace[i];
    const layout = getLayout(defaultLayoutState, measure, 0 /*startY*/);

    // TODO: move these transformations to screen coords to transform stage
    const x = layout.x / state.viewportWidth * 2 - 1;
    const y = layout.y / state.viewportHeight * 2 - 1; // flip sign
    const width = layout.width / state.viewportWidth * 2;
    const height = layout.height / state.viewportHeight * 2;
    positions.push(x, y, 1);
    positions.push(x + width, y, 1);
    positions.push(x, y + height, 1);
    positions.push(x + width, y + height, 1);
    positionLength += SQUARE_VERTICES;

    const color = getColorForMeasure(measure.measure);
    for (let k = 0; k < SQUARE_VERTICES; k++) {
      colors.push(...color);
    }
  }
  // vertices that will be reused each render
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  // vertex colors that will be reused each render
  const colorBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);

  const buffers = {
    position: positionBuffer,
    positionLength,
    color: colorBuffer,
  };

  return buffers;
}

function drawScene(gl, programInfo, buffers, state) {
  let drawCalls = 0;
  gl.clearColor(1, 1, 1, 1.0); // white, fully opaque
  gl.clearDepth(1.0); // Clear everything
  gl.enable(gl.DEPTH_TEST); // Enable depth testing
  gl.depthFunc(gl.LEQUAL); // Near things obscure far things
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); // execute clear canvas

  // Orthographic projection with a width/height
  // ratio that matches the display size of the canvas
  // and we only want to see objects between 0.1 units
  // and 100 units away from the camera.

  const zNear = 0.1;
  const zFar = 100.0;
  const projectionMatrix = mat4.create();

  // orthographic projection. flip y axis
  mat4.ortho(projectionMatrix, -1, 1, 1, -1, zNear, zFar);

  // drawing position starts as the identity point, which is the center of the
  // scene
  const modelViewMatrix = mat4.create();

  // offset to top left
  mat4.translate(
    modelViewMatrix, // destination matrix
    modelViewMatrix, // matrix to translate
    [
      0.0,
      0.0,
      -6.0, // ??? don't get clipped ??? needs to be < -1.0
    ]
  ); // amount to translate

  // TODO: extract transformation logic to render utils
  const offsetX = (state.defaultCenter - state.center) * PX_PER_MS;
  if (state.defaultZoom == 0) {
    throw new Error('will divide by state.defaultZoom of zero');
  }
  const scale = state.zoom / state.defaultZoom;
  mat4.translate(
    modelViewMatrix, // destination matrix
    modelViewMatrix, // matrix to translate
    [
      // TODO: extract transformation logic to render utils
      scale * offsetX / state.viewportWidth * 2, // transform to clip space coords
      0.0,
      0.0,
    ]
  );
  mat4.scale(
    modelViewMatrix, // destination matrix
    modelViewMatrix, // matrix to translate
    [scale, 1.0, 1.0]
  );

  // Tell WebGL to use our program when drawing
  gl.useProgram(programInfo.program);

  // Set the shader uniforms

  gl.uniformMatrix4fv(
    programInfo.uniformLocations.projectionMatrix,
    false,
    projectionMatrix
  );
  gl.uniformMatrix4fv(
    programInfo.uniformLocations.modelViewMatrix,
    false,
    modelViewMatrix
  );

  // Tell WebGL how to pull out the positions from the position
  // buffer into the vertexPosition attribute
  {
    const numComponents = 3;
    const type = gl.FLOAT;
    const normalize = false;
    const stride = 0;
    const offset = numComponents * SQUARE_VERTICES;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.vertexAttribPointer(
      programInfo.attribLocations.vertexPosition,
      numComponents,
      type,
      normalize,
      stride,
      0 //offset
    );
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
  }

  // Tell WebGL how to pull out the colors from the color buffer
  // into the vertexColor attribute.
  {
    const numComponents = 4;
    const type = gl.FLOAT;
    const normalize = false;
    const stride = 0;
    const offset = numComponents * SQUARE_VERTICES;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color);
    gl.vertexAttribPointer(
      programInfo.attribLocations.vertexColor,
      numComponents,
      type,
      normalize,
      stride,
      0 //offset
    );
    gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);
  }

  for (
    let primitiveIdx = 0;
    primitiveIdx < buffers.positionLength / 4;
    primitiveIdx++
  ) {
    {
      const offset = SQUARE_VERTICES * primitiveIdx;
      const count = SQUARE_VERTICES;
      gl.drawArrays(gl.TRIANGLE_STRIP, offset, count);
      drawCalls++;
    }
  }

  // console.log('drawCalls', drawCalls);
}
export function initWebGLRenderer(
  gl: WebGLRenderingContext,
  initState: WebGLRenderState
) {
  // Vertex shader program

  // Initialize a shader program; this is where all the lighting
  // for the vertices and so forth is established.
  const shaderProgram = initShaderProgram(gl, vsSource, fsSource);

  // Collect all the info needed to use the shader program.
  // Look up which attribute our shader program is using
  // for aVertexPosition and look up uniform locations.
  const programInfo = {
    program: shaderProgram,
    attribLocations: {
      vertexPosition: gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
      vertexColor: gl.getAttribLocation(shaderProgram, 'aVertexColor'),
    },
    uniformLocations: {
      projectionMatrix: gl.getUniformLocation(
        shaderProgram,
        'uProjectionMatrix'
      ),
      modelViewMatrix: gl.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
    },
  };
  console.log({programInfo});

  const buffers = initBuffers(gl, initState, programInfo);

  return function rerender(state: WebGLRenderState) {
    drawScene(gl, programInfo, buffers, state);
  };
}
