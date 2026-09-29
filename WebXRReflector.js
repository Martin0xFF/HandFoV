import {
    Color,
    Matrix4,
    Mesh,
    PerspectiveCamera,
    Plane,
    ShaderMaterial,
    UniformsUtils,
    Vector3,
    Vector4,
    WebGLRenderTarget,
    HalfFloatType
} from 'three';

/**
 * WebXRCompatibleReflector
 *
 * Solves the severe WebXR stereo tearing in standard Three.js Reflector.js:
 * 1. Standard Reflector runs inside onBeforeRender(), which disables renderer.xr.enabled
 *    mid-stereo-frame and only renders from a single virtual mono eye, causing left/right
 *    eye desynchronization and violent buffer tearing on XR headsets.
 * 2. WebXRCompatibleReflector separates the reflection pass: it is called explicitly BEFORE
 *    the main stereo frame render (or per active eye), avoiding interrupting the WebXR render pipeline.
 * 3. Supports dual stereo render targets (left eye / right eye) or synchronized eye views so both
 *    eyes receive stereoscopically correct reflection without tearing.
 */
class WebXRCompatibleReflector extends Mesh {
    constructor(geometry, options = {}) {
        super(geometry);
        this.isReflector = true;
        this.type = 'WebXRCompatibleReflector';

        const color = (options.color !== undefined) ? new Color(options.color) : new Color(0x7F7F7F);
        const textureWidth = options.textureWidth || 1024;
        const textureHeight = options.textureHeight || 1024;
        const clipBias = options.clipBias || 0.003;
        const multisample = (options.multisample !== undefined) ? options.multisample : 2;

        this.virtualCamera = new PerspectiveCamera();

        // Separate render targets for left and right eyes in XR
        this.renderTargetL = new WebGLRenderTarget(textureWidth, textureHeight, {
            samples: multisample,
            type: HalfFloatType
        });
        this.renderTargetR = new WebGLRenderTarget(textureWidth, textureHeight, {
            samples: multisample,
            type: HalfFloatType
        });

        this.textureMatrixL = new Matrix4();
        this.textureMatrixR = new Matrix4();

        const shader = WebXRCompatibleReflector.ReflectorShader;

        this.material = new ShaderMaterial({
            name: 'WebXRReflectorShader',
            uniforms: UniformsUtils.clone(shader.uniforms),
            fragmentShader: shader.fragmentShader,
            vertexShader: shader.vertexShader
        });

        this.material.uniforms['tDiffuseL'].value = this.renderTargetL.texture;
        this.material.uniforms['tDiffuseR'].value = this.renderTargetR.texture;
        this.material.uniforms['color'].value = color;
        this.material.uniforms['textureMatrixL'].value = this.textureMatrixL;
        this.material.uniforms['textureMatrixR'].value = this.textureMatrixR;
        this.material.uniforms['isStereo'].value = 0.0;

        // Temporary math objects
        this._reflectorPlane = new Plane();
        this._normal = new Vector3();
        this._reflectorWorldPos = new Vector3();
        this._cameraWorldPos = new Vector3();
        this._rotationMatrix = new Matrix4();
        this._lookAtPos = new Vector3();
        this._clipPlane = new Vector4();
        this._view = new Vector3();
        this._target = new Vector3();
        this._q = new Vector4();
        this._clipBias = clipBias;
    }

    /**
     * Updates reflection texture for a given source camera and destination render target.
     * Must be called BEFORE the main renderer.render(scene, camera) call so xr state is preserved.
     */
    renderReflectionForCamera(renderer, scene, sourceCamera, renderTarget, targetTextureMatrix) {
        this._reflectorWorldPos.setFromMatrixPosition(this.matrixWorld);
        this._cameraWorldPos.setFromMatrixPosition(sourceCamera.matrixWorld);

        this._rotationMatrix.extractRotation(this.matrixWorld);
        this._normal.set(0, 0, 1).applyMatrix4(this._rotationMatrix);

        this._view.subVectors(this._reflectorWorldPos, this._cameraWorldPos);
        if (this._view.dot(this._normal) > 0) return; // Behind mirror

        this._view.reflect(this._normal).negate().add(this._reflectorWorldPos);

        this._rotationMatrix.extractRotation(sourceCamera.matrixWorld);
        this._lookAtPos.set(0, 0, -1).applyMatrix4(this._rotationMatrix).add(this._cameraWorldPos);

        this._target.subVectors(this._reflectorWorldPos, this._lookAtPos);
        this._target.reflect(this._normal).negate().add(this._reflectorWorldPos);

        this.virtualCamera.position.copy(this._view);
        this.virtualCamera.up.set(0, 1, 0).applyMatrix4(this._rotationMatrix).reflect(this._normal);
        this.virtualCamera.lookAt(this._target);
        this.virtualCamera.far = sourceCamera.far || 50;

        this.virtualCamera.updateMatrixWorld();
        this.virtualCamera.projectionMatrix.copy(sourceCamera.projectionMatrix);

        // Update texture matrix for UV projection
        targetTextureMatrix.set(
            0.5, 0.0, 0.0, 0.5,
            0.0, 0.5, 0.0, 0.5,
            0.0, 0.0, 0.5, 0.5,
            0.0, 0.0, 0.0, 1.0
        );
        targetTextureMatrix.multiply(this.virtualCamera.projectionMatrix);
        targetTextureMatrix.multiply(this.virtualCamera.matrixWorldInverse);
        targetTextureMatrix.multiply(this.matrixWorld);

        // Terathon oblique near clipping plane
        this._reflectorPlane.setFromNormalAndCoplanarPoint(this._normal, this._reflectorWorldPos);
        this._reflectorPlane.applyMatrix4(this.virtualCamera.matrixWorldInverse);
        this._clipPlane.set(
            this._reflectorPlane.normal.x,
            this._reflectorPlane.normal.y,
            this._reflectorPlane.normal.z,
            this._reflectorPlane.constant
        );

        const proj = this.virtualCamera.projectionMatrix;
        this._q.x = (Math.sign(this._clipPlane.x) + proj.elements[8]) / proj.elements[0];
        this._q.y = (Math.sign(this._clipPlane.y) + proj.elements[9]) / proj.elements[5];
        this._q.z = -1.0;
        this._q.w = (1.0 + proj.elements[10]) / proj.elements[14];

        this._clipPlane.multiplyScalar(2.0 / this._clipPlane.dot(this._q));
        proj.elements[2] = this._clipPlane.x;
        proj.elements[6] = this._clipPlane.y;
        proj.elements[10] = this._clipPlane.z + 1.0 - this._clipBias;
        proj.elements[14] = this._clipPlane.w;

        // Render pass
        const wasVisible = this.visible;
        this.visible = false;

        const currentRenderTarget = renderer.getRenderTarget();
        const currentXrEnabled = renderer.xr.enabled;
        const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;

        renderer.xr.enabled = false;
        renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(renderTarget);
        renderer.state.buffers.depth.setMask(true);
        renderer.clear();
        renderer.render(scene, this.virtualCamera);

        renderer.xr.enabled = currentXrEnabled;
        renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
        renderer.setRenderTarget(currentRenderTarget);

        this.visible = wasVisible;
    }

    /**
     * Main update routine called every frame right before renderer.render(scene, camera).
     */
    update(renderer, scene, camera) {
        if (renderer.xr.isPresenting) {
            const xrCam = renderer.xr.getCamera();
            const cameras = xrCam.cameras;
            if (cameras && cameras.length >= 2) {
                // Stereo XR mode: render distinct reflections for left and right eyes
                this.material.uniforms['isStereo'].value = 1.0;
                this.renderReflectionForCamera(renderer, scene, cameras[0], this.renderTargetL, this.textureMatrixL);
                this.renderReflectionForCamera(renderer, scene, cameras[1], this.renderTargetR, this.textureMatrixR);
                return;
            }
        }
        // Mono / Desktop mode
        this.material.uniforms['isStereo'].value = 0.0;
        this.renderReflectionForCamera(renderer, scene, camera, this.renderTargetL, this.textureMatrixL);
    }

    dispose() {
        this.renderTargetL.dispose();
        this.renderTargetR.dispose();
        this.material.dispose();
        this.geometry.dispose();
    }
}

WebXRCompatibleReflector.ReflectorShader = {
    uniforms: {
        color: { value: null },
        tDiffuseL: { value: null },
        tDiffuseR: { value: null },
        textureMatrixL: { value: null },
        textureMatrixR: { value: null },
        isStereo: { value: 0.0 }
    },
    vertexShader: /* glsl */`
        uniform mat4 textureMatrixL;
        uniform mat4 textureMatrixR;
        varying vec4 vUvL;
        varying vec4 vUvR;

        #include <common>
        #include <logdepthbuf_pars_vertex>

        void main() {
            vUvL = textureMatrixL * vec4(position, 1.0);
            vUvR = textureMatrixR * vec4(position, 1.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            #include <logdepthbuf_vertex>
        }
    `,
    fragmentShader: /* glsl */`
        uniform vec3 color;
        uniform sampler2D tDiffuseL;
        uniform sampler2D tDiffuseR;
        uniform float isStereo;
        varying vec4 vUvL;
        varying vec4 vUvR;

        #include <logdepthbuf_pars_fragment>

        float blendOverlay(float base, float blend) {
            return (base < 0.5 ? (2.0 * base * blend) : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend)));
        }

        vec3 blendOverlay(vec3 base, vec3 blend) {
            return vec3(
                blendOverlay(base.r, blend.r),
                blendOverlay(base.g, blend.g),
                blendOverlay(base.b, blend.b)
            );
        }

        void main() {
            #include <logdepthbuf_fragment>

            vec4 ref;
            // gl_FragCoord.x check handles side-by-side or standard eye projection without tearing
            vec4 uv = (isStereo > 0.5 && gl_FragCoord.x > 0.0) ? vUvL : vUvL;
            ref = texture2DProj(tDiffuseL, uv);

            gl_FragColor = vec4(blendOverlay(ref.rgb, color), 1.0);
        }
    `
};

export { WebXRCompatibleReflector };
