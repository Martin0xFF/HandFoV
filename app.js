import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

// DOM Elements
const enterXrBtn = document.getElementById('enter-xr-btn');
const xrSupportBadge = document.getElementById('xr-support-badge');
const metricHeadPitch = document.getElementById('metric-head-pitch');
const metricLeftAngle = document.getElementById('metric-left-angle');
const metricRightAngle = document.getElementById('metric-right-angle');
const metricTrackingStatus = document.getElementById('metric-tracking-status');
const container = document.getElementById('canvas-container');

// Core Three.js components
let renderer, scene, camera;

// Controllers & Hands
let controller1, controller2;
let controllerGrip1, controllerGrip2;
let hand1, hand2;
let handModel1, handModel2;
const handModelFactory = new XRHandModelFactory();

// Floating Forward HUD Display
let hudCanvas, hudTexture, hudMesh;

// Head Location Visualizers (user head location & mirrored head in world space)
let headVisualizer = null;
let projectedHeadVisualizer = null;

// World-locked virtual mirror plane (2.0 meters in front, fixed in world space)
const worldMirrorPlane = {
    initialized: false,
    origin: new THREE.Vector3(0, 1.5, -2.0), // Point on mirror plane in world coordinates
    normal: new THREE.Vector3(0, 0, 1),       // Facing back toward user (+Z in default world space)
    right: new THREE.Vector3(1, 0, 0),        // Horizontal axis along mirror plane
    up: new THREE.Vector3(0, 1, 0)            // Vertical axis along mirror plane
};

// Hand tracking data structures
const handsState = {
    left: {
        active: false,
        palmPos: new THREE.Vector3(),
        prevPalmPos: new THREE.Vector3(),
        freezeFrameCount: 0,
        subtendedAngleDeg: 0,
        lastValidAngleDeg: null,
        distance: 0,
        elevationDeg: 0,
        azimuthDeg: 0,
        mesh: null,
        visualGroup: null,
        visualArc: null,
        visualGazeRay: null,
        visualPalmRay: null
    },
    right: {
        active: false,
        palmPos: new THREE.Vector3(),
        prevPalmPos: new THREE.Vector3(),
        freezeFrameCount: 0,
        subtendedAngleDeg: 0,
        lastValidAngleDeg: null,
        distance: 0,
        elevationDeg: 0,
        azimuthDeg: 0,
        mesh: null,
        visualGroup: null,
        visualArc: null,
        visualGazeRay: null,
        visualPalmRay: null
    }
};

// Second Hand Renderings (Projected Hands in front of user for direct visibility)
const projectedHands = {
    left: null,
    right: null
};

// Simulation state for desktop preview
let isDesktopSim = true;
let simHandPos = new THREE.Vector3(0.2, 1.2, -0.5);
let mouseIsDown = false;
let spaceIsDown = false;
let prevMousePos = { x: 0, y: 0 };
let cameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');

init();

function init() {
    // 1. Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e131f);
    scene.fog = new THREE.FogExp2(0x0e131f, 0.05);

    // 2. Camera setup
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
    camera.position.set(0, 1.6, 0.5);

    // 3. Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    // 4. Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambientLight);

    const dirLightFront = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLightFront.position.set(2, 4, 3);
    scene.add(dirLightFront);

    const dirLightBack = new THREE.DirectionalLight(0x58a6ff, 0.8);
    dirLightBack.position.set(-2, 3, -3);
    scene.add(dirLightBack);

    // 5. Environment Grid & Floor
    setupEnvironment();

    // 6. Floating In-VR HUD (Angle readout dashboard right in front of user)
    setupFloatingHUD();

    // 7. Setup WebXR Hand Tracking & Controllers
    setupXR();

    // 8. Visual Ray & Angle Arc indicators for real hands
    setupAngleVisualizers('left', 0x58a6ff);
    setupAngleVisualizers('right', 0x3fb950);

    // 9. Setup Projected Second Hand Models (Rendered in front at eye level for effortless review)
    setupProjectedHands();

    // 10. Setup Head Location Visualizers
    setupHeadVisualizers();

    // 11. Setup Desktop Controls / Fallback Hand Simulation
    setupDesktopControls();

    // Window resize
    window.addEventListener('resize', onWindowResize);

    // Animation Loop
    renderer.setAnimationLoop(render);
}

function setupEnvironment() {
    const grid = new THREE.GridHelper(20, 40, 0x58a6ff, 0x242d3d);
    grid.position.y = 0.001;
    scene.add(grid);

    const floorGeo = new THREE.PlaneGeometry(20, 20);
    const floorMat = new THREE.MeshStandardMaterial({
        color: 0x0a0e17,
        roughness: 0.8,
        metalness: 0.1
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // Subtle room reference pillars
    const pillarGeo = new THREE.CylinderGeometry(0.04, 0.04, 3, 16);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x242d3d, metalness: 0.4, roughness: 0.5 });
    for (let x = -2; x <= 2; x += 4) {
        for (let z = -2; z <= 2; z += 4) {
            const pillar = new THREE.Mesh(pillarGeo, pillarMat);
            pillar.position.set(x, 1.5, z);
            scene.add(pillar);
        }
    }
}

function setupFloatingHUD() {
    hudCanvas = document.createElement('canvas');
    hudCanvas.width = 1024;
    hudCanvas.height = 320;
    hudTexture = new THREE.CanvasTexture(hudCanvas);
    hudTexture.minFilter = THREE.LinearFilter;

    const hudPlaneGeo = new THREE.PlaneGeometry(1.5, 0.46);
    const hudPlaneMat = new THREE.MeshBasicMaterial({
        map: hudTexture,
        transparent: true,
        side: THREE.DoubleSide
    });
    hudMesh = new THREE.Mesh(hudPlaneGeo, hudPlaneMat);
    // Positioned floating 2.0m directly in front of user at comfortable eye/chest level (y=1.45)
    hudMesh.position.set(0, 1.45, -2.0);
    scene.add(hudMesh);

    // Frame
    const hudFrame = new THREE.Mesh(
        new THREE.BoxGeometry(1.54, 0.50, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x1c2333, metalness: 0.8, roughness: 0.3 })
    );
    hudFrame.position.set(0, 0, -0.015);
    hudMesh.add(hudFrame);
}

function updateHUD() {
    if (!hudCanvas) return;
    const ctx = hudCanvas.getContext('2d');
    ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);

    // Background card
    ctx.fillStyle = 'rgba(14, 19, 31, 0.94)';
    ctx.strokeStyle = '#388bfd';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(10, 10, hudCanvas.width - 20, hudCanvas.height - 20, 24);
    ctx.fill();
    ctx.stroke();

    // Title
    ctx.fillStyle = '#58a6ff';
    ctx.font = 'bold 36px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HAND TRACKING FOV & VERTICAL ANGLE', hudCanvas.width / 2, 60);

    // Subtitle
    ctx.fillStyle = '#8b949e';
    ctx.font = '22px -apple-system, sans-serif';
    ctx.fillText('Vertical Angle from Head Gaze Direction down to Hand Palm', hudCanvas.width / 2, 98);

    // Divider
    ctx.strokeStyle = '#30363d';
    ctx.beginPath();
    ctx.moveTo(30, 118);
    ctx.lineTo(hudCanvas.width - 30, 118);
    ctx.stroke();

    // Left hand status
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'left';
    if (handsState.left.active) {
        ctx.fillStyle = '#58a6ff';
        ctx.fillText(`LEFT HAND:  ▼ ${handsState.left.subtendedAngleDeg.toFixed(1)}°`, 50, 180);
        ctx.font = '24px monospace';
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(`Dist: ${(handsState.left.distance * 100).toFixed(0)}cm  Elev: ${handsState.left.elevationDeg.toFixed(1)}°`, 50, 230);
    } else {
        ctx.fillStyle = '#f85149';
        const degStr = handsState.left.lastValidAngleDeg !== null ? `${handsState.left.lastValidAngleDeg.toFixed(1)}° ` : '';
        ctx.fillText(`LEFT HAND:  ▼ ${degStr}TRACKING_LOST`, 50, 180);
        ctx.font = '22px monospace';
        ctx.fillStyle = '#8b949e';
        ctx.fillText('(Hand not detected in FOV)', 50, 230);
    }

    // Right hand status
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'left';
    if (handsState.right.active) {
        ctx.fillStyle = '#3fb950';
        ctx.fillText(`RIGHT HAND: ▼ ${handsState.right.subtendedAngleDeg.toFixed(1)}°`, 540, 180);
        ctx.font = '24px monospace';
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(`Dist: ${(handsState.right.distance * 100).toFixed(0)}cm  Elev: ${handsState.right.elevationDeg.toFixed(1)}°`, 540, 230);
    } else {
        ctx.fillStyle = '#f85149';
        const degStr = handsState.right.lastValidAngleDeg !== null ? `${handsState.right.lastValidAngleDeg.toFixed(1)}° ` : '';
        ctx.fillText(`RIGHT HAND: ▼ ${degStr}TRACKING_LOST`, 540, 180);
        ctx.font = '22px monospace';
        ctx.fillStyle = '#8b949e';
        ctx.fillText('(Hand not detected in FOV)', 540, 230);
    }

    // Footer info
    ctx.font = '19px sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.textAlign = 'center';
    ctx.fillText('Mirrored hands rendered 2m in front (flipped as a mirror)', hudCanvas.width / 2, 285);

    hudTexture.needsUpdate = true;
}

function setupProjectedHands() {
    const jointNames = [
        'wrist',
        'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
        'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
        'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
        'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
        'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'
    ];

    ['left', 'right'].forEach((side) => {
        const group = new THREE.Group();
        const jointMeshes = {};
        const color = side === 'left' ? 0x58a6ff : 0x3fb950;
        const mat = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.35,
            metalness: 0.3,
            roughness: 0.3
        });

        jointNames.forEach((name) => {
            const radius = name.includes('tip') ? 0.012 : (name === 'wrist' ? 0.018 : 0.014);
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12), mat);
            mesh.visible = false;
            group.add(mesh);
            jointMeshes[name] = mesh;
        });

        // Palm plate
        const palmPlate = new THREE.Mesh(
            new THREE.BoxGeometry(0.075, 0.02, 0.08),
            new THREE.MeshStandardMaterial({
                color: color,
                emissive: color,
                emissiveIntensity: 0.25,
                metalness: 0.5,
                roughness: 0.3
            })
        );
        palmPlate.visible = false;
        group.add(palmPlate);

        // Angle billboard label attached directly to the projected hand
        const labelCanvas = document.createElement('canvas');
        labelCanvas.width = 256;
        labelCanvas.height = 128;
        const labelTexture = new THREE.CanvasTexture(labelCanvas);
        const labelMat = new THREE.SpriteMaterial({ map: labelTexture, depthTest: false });
        const labelSprite = new THREE.Sprite(labelMat);
        labelSprite.scale.set(0.22, 0.11, 1);
        group.add(labelSprite);

        group.visible = false;
        scene.add(group);

        projectedHands[side] = {
            group: group,
            jointMeshes: jointMeshes,
            palmPlate: palmPlate,
            labelSprite: labelSprite,
            labelCanvas: labelCanvas,
            labelTexture: labelTexture
        };
    });
}

function updateProjectedHandLabel(side, angleDeg) {
    const proj = projectedHands[side];
    if (!proj || !proj.labelCanvas) return;
    const ctx = proj.labelCanvas.getContext('2d');
    ctx.clearRect(0, 0, proj.labelCanvas.width, proj.labelCanvas.height);

    ctx.fillStyle = 'rgba(13, 17, 23, 0.90)';
    ctx.strokeStyle = side === 'left' ? '#58a6ff' : '#3fb950';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(8, 8, proj.labelCanvas.width - 16, proj.labelCanvas.height - 16, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${angleDeg.toFixed(1)}°`, proj.labelCanvas.width / 2, 54);

    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('Vertical FOV', proj.labelCanvas.width / 2, 88);

    proj.labelTexture.needsUpdate = true;
}

function setupHeadVisualizers() {
    // 1. Real Head Location Visualizer (world point with ring and gaze arrow)
    const headGroup = new THREE.Group();

    // Floating subtle glowing marker at head position
    const headSphereGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const headSphereMat = new THREE.MeshStandardMaterial({
        color: 0x58a6ff,
        emissive: 0x58a6ff,
        emissiveIntensity: 0.4,
        roughness: 0.3
    });
    const headSphere = new THREE.Mesh(headSphereGeo, headSphereMat);
    headGroup.add(headSphere);

    // Horizon coordinate ring around head
    const ringGeo = new THREE.RingGeometry(0.12, 0.14, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff, side: THREE.DoubleSide });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    headGroup.add(ringMesh);

    scene.add(headGroup);
    headVisualizer = {
        group: headGroup,
        sphere: headSphere
    };

    // 2. Projected / Mirrored Head Location (2m in front across the mirror plane)
    const mirHeadGroup = new THREE.Group();

    // Mirrored head avatar sphere
    const mirSphereGeo = new THREE.SphereGeometry(0.09, 20, 20);
    const mirSphereMat = new THREE.MeshStandardMaterial({
        color: 0x388bfd,
        emissive: 0x1f6feb,
        emissiveIntensity: 0.35,
        roughness: 0.4
    });
    const mirSphere = new THREE.Mesh(mirSphereGeo, mirSphereMat);
    mirHeadGroup.add(mirSphere);

    // Stylized VR headset visor
    const visorGeo = new THREE.BoxGeometry(0.18, 0.08, 0.10);
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x0d1117, metalness: 0.9, roughness: 0.1 });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.01, 0.05);
    mirHeadGroup.add(visor);

    // Visor LED strip
    const stripGeo = new THREE.BoxGeometry(0.16, 0.02, 0.01);
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x58a6ff });
    const strip = new THREE.Mesh(stripGeo, stripMat);
    strip.position.set(0, 0.01, 0.105);
    mirHeadGroup.add(strip);

    // Billboard label: "HEAD LOCATION"
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256;
    labelCanvas.height = 80;
    const ctx = labelCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(13, 17, 23, 0.85)';
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(6, 6, labelCanvas.width - 12, labelCanvas.height - 12, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#58a6ff';
    ctx.font = 'bold 24px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HEAD LOCATION', labelCanvas.width / 2, 48);

    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const labelMat = new THREE.SpriteMaterial({ map: labelTexture, depthTest: false });
    const labelSprite = new THREE.Sprite(labelMat);
    labelSprite.scale.set(0.3, 0.09, 1);
    labelSprite.position.set(0, 0.18, 0);
    mirHeadGroup.add(labelSprite);

    scene.add(mirHeadGroup);
    projectedHeadVisualizer = {
        group: mirHeadGroup,
        sphere: mirSphere
    };
}

function updateHeadVisualizers(headPos, headForward, mirrorOrigin, mirrorNormal) {
    // 1. Update real head visualizer position
    if (headVisualizer) {
        headVisualizer.group.position.copy(headPos);
    }

    // 2. Update mirrored head visualizer across world mirror plane
    if (projectedHeadVisualizer && mirrorOrigin && mirrorNormal) {
        // Mirrored head location:
        const distToPlane = headPos.clone().sub(mirrorOrigin).dot(mirrorNormal);
        const mirHeadPos = headPos.clone().sub(mirrorNormal.clone().multiplyScalar(2 * distToPlane));

        projectedHeadVisualizer.group.position.copy(mirHeadPos);
        // Face back towards the user
        projectedHeadVisualizer.group.lookAt(headPos.x, mirHeadPos.y, headPos.z);
    }
}

function updateProjectedHands(headPos, headForward) {
    // 1. Initialize fixed world-locked mirror plane once (or upon entering XR)
    if (!worldMirrorPlane.initialized) {
        // Horizontal forward vector (ignoring pitch tilt for world plane)
        const forwardHorizontal = new THREE.Vector3(headForward.x, 0, headForward.z).normalize();
        if (forwardHorizontal.lengthSq() < 0.001) {
            forwardHorizontal.set(0, 0, -1);
        }

        // Mirror is located exactly 2.0m forward in world space
        worldMirrorPlane.origin.copy(headPos).add(forwardHorizontal.clone().multiplyScalar(2.0));
        // Mirror plane normal points back toward user
        worldMirrorPlane.normal.copy(forwardHorizontal).negate();
        // Horizontal axis along mirror plane
        worldMirrorPlane.right.crossVectors(new THREE.Vector3(0, 1, 0), worldMirrorPlane.normal).normalize();
        // Vertical axis along mirror plane
        worldMirrorPlane.up.set(0, 1, 0);

        // Lock the HUD at this world position 2.0m in front
        if (hudMesh) {
            hudMesh.position.copy(worldMirrorPlane.origin);
            hudMesh.position.y = Math.max(1.2, headPos.y); // comfortable eye level
            hudMesh.lookAt(headPos.x, hudMesh.position.y, headPos.z);
        }

        worldMirrorPlane.initialized = true;
    }

    const mirrorOrigin = worldMirrorPlane.origin;
    const mirrorNormal = worldMirrorPlane.normal;

    // Update real and mirrored head location visualizers
    updateHeadVisualizers(headPos, headForward, mirrorOrigin, mirrorNormal);

    const handObjects = [
        { obj: hand1, fallback: 'left' },
        { obj: hand2, fallback: 'right' }
    ];

    handObjects.forEach(({ obj, fallback }) => {
        if (obj && obj.joints) {
            const handedness = obj.inputSource?.handedness || fallback;
            const projHand = projectedHands[handedness];
            if (!projHand) return;

            if (handsState[handedness].active) {
                projHand.group.visible = true;

                const tempPos = new THREE.Vector3();
                let palmProjectedPos = null;

                for (const [name, joint] of Object.entries(obj.joints)) {
                    const jointMesh = projHand.jointMeshes[name];
                    if (jointMesh) {
                        joint.getWorldPosition(tempPos);

                        // Pure world-locked geometric reflection across fixed plane (mirrorOrigin, mirrorNormal):
                        // P_mirrored = P - 2 * ((P - mirrorOrigin) . normal) * normal
                        const distToPlane = tempPos.clone().sub(mirrorOrigin).dot(mirrorNormal);
                        const mirJointPos = tempPos.clone().sub(mirrorNormal.clone().multiplyScalar(2 * distToPlane));

                        jointMesh.position.copy(mirJointPos);
                        jointMesh.visible = true;

                        if (name === 'palm' || (!palmProjectedPos && (name === 'middle-finger-metacarpal' || name === 'wrist'))) {
                            palmProjectedPos = mirJointPos.clone();
                        }
                    }
                }

                // Mirrored palm plate
                const palmJoint = obj.joints['palm'] || obj.joints['middle-finger-metacarpal'] || obj.joints['wrist'];
                if (palmJoint && palmProjectedPos) {
                    projHand.palmPlate.position.copy(palmProjectedPos);
                    projHand.palmPlate.visible = true;

                    // Position angle label above mirrored palm in world space
                    projHand.labelSprite.position.copy(palmProjectedPos.clone().add(new THREE.Vector3(0, 0.12, 0)));
                    updateProjectedHandLabel(handedness, handsState[handedness].subtendedAngleDeg);
                }
            } else {
                projHand.group.visible = false;
            }
        }
    });

    // Desktop Sim Hand Projection (Reflected across fixed world plane)
    if (isDesktopSim && handsState.right.active && projectedHands.right) {
        const projHand = projectedHands.right;
        projHand.group.visible = true;

        const simPos = handsState.right.palmPos;
        const distToPlane = simPos.clone().sub(mirrorOrigin).dot(mirrorNormal);
        const mirPalmPos = simPos.clone().sub(mirrorNormal.clone().multiplyScalar(2 * distToPlane));

        projHand.palmPlate.position.copy(mirPalmPos);
        projHand.palmPlate.visible = true;

        for (const [name, jointMesh] of Object.entries(projHand.jointMeshes)) {
            jointMesh.position.copy(mirPalmPos);
            jointMesh.visible = true;
        }

        projHand.labelSprite.position.copy(mirPalmPos.clone().add(new THREE.Vector3(0, 0.12, 0)));
        updateProjectedHandLabel('right', handsState.right.subtendedAngleDeg);
    }
}

function setupAngleVisualizers(handedness, colorHex) {
    const group = new THREE.Group();

    // 1. Ray along gaze direction
    const gazeRayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
    ]);
    const gazeRayMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
    const gazeRay = new THREE.Line(gazeRayGeo, gazeRayMat);
    group.add(gazeRay);

    // 2. Ray from head to palm
    const palmRayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
    ]);
    const palmRayMat = new THREE.LineBasicMaterial({ color: colorHex, linewidth: 2 });
    const palmRay = new THREE.Line(palmRayGeo, palmRayMat);
    group.add(palmRay);

    // 3. Subtended angle circular arc
    const arcSegments = 32;
    const arcPositions = new Float32Array((arcSegments + 1) * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
    const arcMat = new THREE.LineBasicMaterial({ color: colorHex, linewidth: 3 });
    const visualArc = new THREE.Line(arcGeo, arcMat);
    group.add(visualArc);

    // 4. Palm marker sphere (glow point)
    const markerGeo = new THREE.SphereGeometry(0.025, 16, 16);
    const markerMat = new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    group.add(marker);

    // 5. World text billboard near real palm showing angle
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256;
    labelCanvas.height = 128;
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const labelMat = new THREE.SpriteMaterial({ map: labelTexture, depthTest: false });
    const labelSprite = new THREE.Sprite(labelMat);
    labelSprite.scale.set(0.18, 0.09, 1);
    group.add(labelSprite);

    group.visible = false;
    scene.add(group);

    handsState[handedness].visualGroup = group;
    handsState[handedness].visualGazeRay = gazeRay;
    handsState[handedness].visualPalmRay = palmRay;
    handsState[handedness].visualArc = visualArc;
    handsState[handedness].marker = marker;
    handsState[handedness].labelSprite = labelSprite;
    handsState[handedness].labelCanvas = labelCanvas;
    handsState[handedness].labelTexture = labelTexture;
}

function updateHandLabel(handedness, angleDeg) {
    const hand = handsState[handedness];
    if (!hand.labelCanvas) return;
    const ctx = hand.labelCanvas.getContext('2d');
    ctx.clearRect(0, 0, hand.labelCanvas.width, hand.labelCanvas.height);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeStyle = handedness === 'left' ? '#58a6ff' : '#3fb950';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(8, 8, hand.labelCanvas.width - 16, hand.labelCanvas.height - 16, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${angleDeg.toFixed(1)}°`, hand.labelCanvas.width / 2, 54);

    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('Vertical FOV', hand.labelCanvas.width / 2, 88);

    hand.labelTexture.needsUpdate = true;
}

function setupXR() {
    if ('xr' in navigator) {
        navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
            if (supported) {
                xrSupportBadge.textContent = 'Immersive VR Supported with Hand Tracking';
                xrSupportBadge.className = 'status-badge supported';
                enterXrBtn.disabled = false;
                enterXrBtn.onclick = () => startXRSession('immersive-vr');
            } else {
                navigator.xr.isSessionSupported('immersive-ar').then((arSupported) => {
                    if (arSupported) {
                        xrSupportBadge.textContent = 'Immersive AR Supported';
                        xrSupportBadge.className = 'status-badge supported';
                        enterXrBtn.disabled = false;
                        enterXrBtn.onclick = () => startXRSession('immersive-ar');
                    } else {
                        xrSupportBadge.textContent = 'WebXR Not Supported (Running Desktop Simulator)';
                        xrSupportBadge.className = 'status-badge unsupported';
                    }
                });
            }
        }).catch(() => {
            xrSupportBadge.textContent = 'WebXR Query Error (Running Desktop Simulator)';
            xrSupportBadge.className = 'status-badge unsupported';
        });
    } else {
        xrSupportBadge.textContent = 'WebXR Not Available in this Browser (Desktop Sim Active)';
        xrSupportBadge.className = 'status-badge unsupported';
    }

    controller1 = renderer.xr.getController(0);
    scene.add(controller1);

    controller2 = renderer.xr.getController(1);
    scene.add(controller2);

    const controllerModelFactory = new XRControllerModelFactory();
    controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);

    // Hand tracking controllers
    hand1 = renderer.xr.getHand(0);
    handModel1 = handModelFactory.createHandModel(hand1, 'spheres');
    hand1.add(handModel1);
    scene.add(hand1);

    hand2 = renderer.xr.getHand(1);
    handModel2 = handModelFactory.createHandModel(hand2, 'spheres');
    hand2.add(handModel2);
    scene.add(hand2);

    hand1.addEventListener('connected', (event) => onHandConnected(event, 0));
    hand1.addEventListener('disconnected', (event) => onHandDisconnected(event, 0));

    hand2.addEventListener('connected', (event) => onHandConnected(event, 1));
    hand2.addEventListener('disconnected', (event) => onHandDisconnected(event, 1));

    renderer.xr.addEventListener('sessionstart', () => {
        isDesktopSim = false;
        worldMirrorPlane.initialized = false; // Will lock 2m in front in world space on first frame
        enterXrBtn.textContent = 'Exit XR Session';
        enterXrBtn.onclick = () => {
            renderer.xr.getSession()?.end();
        };
    });

    renderer.xr.addEventListener('sessionend', () => {
        isDesktopSim = true;
        worldMirrorPlane.initialized = false;
        enterXrBtn.textContent = 'Enter Immersive VR / AR';
        enterXrBtn.onclick = () => startXRSession('immersive-vr');
    });
}

function onHandConnected(event, index) {
    const xrInputSource = event.data;
    const handedness = xrInputSource.handedness;
    if (handedness === 'left' || handedness === 'right') {
        handsState[handedness].active = true;
        handsState[handedness].xrHand = xrInputSource.hand;
    }
}

function onHandDisconnected(event, index) {
    const xrInputSource = event.data;
    const handedness = xrInputSource.handedness;
    if (handedness === 'left' || handedness === 'right') {
        handsState[handedness].active = false;
        handsState[handedness].xrHand = null;
        if (handsState[handedness].visualGroup) {
            handsState[handedness].visualGroup.visible = false;
        }
        if (projectedHands[handedness]) {
            projectedHands[handedness].group.visible = false;
        }
        if (handedness === 'left') {
            if (handModel1) handModel1.visible = false;
            if (hand1) hand1.visible = false;
        } else {
            if (handModel2) handModel2.visible = false;
            if (hand2) hand2.visible = false;
        }
    }
}

async function startXRSession(mode) {
    if (!navigator.xr) return;
    try {
        const session = await navigator.xr.requestSession(mode, {
            optionalFeatures: ['hand-tracking', 'local-floor', 'bounded-floor']
        });
        renderer.xr.setSession(session);
    } catch (err) {
        console.error('Failed to start XR session:', err);
        alert(`Failed to start WebXR session: ${err.message}`);
    }
}

function setupDesktopControls() {
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') spaceIsDown = true;
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') spaceIsDown = false;
    });

    window.addEventListener('mousedown', (e) => {
        if (e.target.closest('#ui-overlay')) return;
        mouseIsDown = true;
        prevMousePos = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
        mouseIsDown = false;
    });

    window.addEventListener('mousemove', (e) => {
        if (!mouseIsDown) return;
        const dx = e.clientX - prevMousePos.x;
        const dy = e.clientY - prevMousePos.y;
        prevMousePos = { x: e.clientX, y: e.clientY };

        if (spaceIsDown) {
            simHandPos.x += dx * 0.002;
            simHandPos.y -= dy * 0.002;
        } else {
            cameraEuler.y -= dx * 0.003;
            cameraEuler.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, cameraEuler.x - dy * 0.003));
            camera.quaternion.setFromEuler(cameraEuler);
        }
    });

    window.addEventListener('wheel', (e) => {
        if (spaceIsDown) {
            simHandPos.z = Math.max(-1.2, Math.min(-0.2, simHandPos.z + e.deltaY * 0.001));
        }
    });
}

function calculateHandFOV(headPos, headForward, handPos) {
    const headToHand = new THREE.Vector3().subVectors(handPos, headPos);
    const distance = headToHand.length();
    if (distance < 0.0001) return { angleDeg: 0, distance: 0, elevationDeg: 0, azimuthDeg: 0 };

    const headToHandDir = headToHand.clone().normalize();

    const dot = Math.min(1.0, Math.max(-1.0, headForward.dot(headToHandDir)));
    const totalAngleDeg = THREE.MathUtils.radToDeg(Math.acos(dot));

    const headRight = new THREE.Vector3();
    const headUp = new THREE.Vector3(0, 1, 0);
    headRight.crossVectors(headForward, headUp).normalize();
    const actualHeadUp = new THREE.Vector3().crossVectors(headRight, headForward).normalize();

    const projForward = headToHandDir.dot(headForward);
    const projUp = headToHandDir.dot(actualHeadUp);
    const projRight = headToHandDir.dot(headRight);

    const elevationRad = Math.atan2(projUp, projForward);
    const elevationDeg = THREE.MathUtils.radToDeg(elevationRad);
    const verticalAngleDownDeg = -elevationDeg;

    const azimuthRad = Math.atan2(projRight, projForward);
    const azimuthDeg = THREE.MathUtils.radToDeg(azimuthRad);

    return {
        angleDeg: verticalAngleDownDeg,
        totalAngleDeg: totalAngleDeg,
        distance: distance,
        elevationDeg: elevationDeg,
        azimuthDeg: azimuthDeg
    };
}

function updateVisualizer(handedness, headPos, headForward, palmPos, angleInfo) {
    const hand = handsState[handedness];
    if (!hand.visualGroup) return;

    hand.visualGroup.visible = true;
    hand.marker.position.copy(palmPos);

    const gazeRayPoints = [
        headPos.clone(),
        headPos.clone().add(headForward.clone().multiplyScalar(0.8))
    ];
    hand.visualGazeRay.geometry.setFromPoints(gazeRayPoints);

    const palmRayPoints = [
        headPos.clone(),
        palmPos.clone()
    ];
    hand.visualPalmRay.geometry.setFromPoints(palmRayPoints);

    const arcRadius = Math.min(0.35, angleInfo.distance * 0.7);
    const headToPalmDir = new THREE.Vector3().subVectors(palmPos, headPos).normalize();

    const arcPoints = [];
    const segments = 32;
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const qGaze = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), headForward);
        const qPalm = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), headToPalmDir);
        const qInterp = new THREE.Quaternion().copy(qGaze).slerp(qPalm, t);
        const v = new THREE.Vector3(0, 0, arcRadius).applyQuaternion(qInterp).add(headPos);
        arcPoints.push(v);
    }
    hand.visualArc.geometry.setFromPoints(arcPoints);

    const labelPos = palmPos.clone().add(new THREE.Vector3(0, 0.08, 0));
    hand.labelSprite.position.copy(labelPos);
    updateHandLabel(handedness, angleInfo.angleDeg);
}

function updateTrackingAndMetrics(frame) {
    const headPos = new THREE.Vector3();
    const headForward = new THREE.Vector3();

    camera.getWorldPosition(headPos);
    camera.getWorldDirection(headForward);

    const headPitchDeg = THREE.MathUtils.radToDeg(Math.asin(headForward.y));
    metricHeadPitch.textContent = `${headPitchDeg.toFixed(1)}° (${headPitchDeg < 0 ? 'looking down' : 'looking up'})`;

    let hardwareHandsFound = { left: false, right: false };
    const referenceSpace = renderer.xr.getReferenceSpace();

    // A. WebXR Hardware Hands
    const hands = [
        { obj: hand1, model: handModel1, fallback: 'left' },
        { obj: hand2, model: handModel2, fallback: 'right' }
    ];

    hands.forEach(({ obj, model, fallback }) => {
        if (obj && obj.joints) {
            const wrist = obj.joints['wrist'];
            const middleMetacarpal = obj.joints['middle-finger-metacarpal'] || obj.joints['middle-finger-phalanx-proximal'];
            const palmJoint = obj.joints['palm'] || middleMetacarpal || wrist;

            // Tracking signal:
            // 1. Direct WebXR frame.getJointPose check (returns null when untracked)
            let isTracked = false;
            if (frame && referenceSpace && obj.inputSource && obj.inputSource.hand) {
                const jointSpace = obj.inputSource.hand.get('wrist') || obj.inputSource.hand.get('palm');
                if (jointSpace) {
                    const pose = frame.getJointPose(jointSpace, referenceSpace);
                    isTracked = (pose !== null && pose !== undefined);
                }
            } else if (palmJoint) {
                isTracked = palmJoint.visible;
            }

            const handedness = obj.inputSource?.handedness || fallback;
            const handState = handsState[handedness];

            // 2. Identical position check: if position is identically the same for 5 frames, tracking is lost
            if (isTracked && palmJoint) {
                const currentPos = new THREE.Vector3();
                palmJoint.getWorldPosition(currentPos);

                // If position difference squared is under 1e-7 for 5 consecutive frames,
                // the hand is identically frozen and tracking is lost.
                const distSq = currentPos.distanceToSquared(handState.prevPalmPos);
                if (distSq < 1e-7) {
                    handState.freezeFrameCount++;
                    if (handState.freezeFrameCount >= 5) {
                        isTracked = false; // Frozen for 5 frames -> tracking lost
                    }
                } else {
                    handState.freezeFrameCount = 0;
                    handState.prevPalmPos.copy(currentPos);
                }
            } else {
                handState.freezeFrameCount = 0;
            }

            if (isTracked) {
                handState.active = true;
                hardwareHandsFound[handedness] = true;
                if (model) model.visible = true;
                obj.visible = true;
                palmJoint.getWorldPosition(handState.palmPos);

                const metrics = calculateHandFOV(headPos, headForward, handState.palmPos);
                handState.subtendedAngleDeg = metrics.angleDeg;
                handState.lastValidAngleDeg = metrics.angleDeg;
                handState.distance = metrics.distance;
                handState.elevationDeg = metrics.elevationDeg;
                handState.azimuthDeg = metrics.azimuthDeg;

                updateVisualizer(handedness, headPos, headForward, handState.palmPos, metrics);
            } else {
                // Tracking lost for this hand: explicitly hide models so they never freeze in space
                if (model) model.visible = false;
                obj.visible = false;
            }
        }
    });

    // Detect exit from FOV for hardware hands
    ['left', 'right'].forEach((side) => {
        if (!hardwareHandsFound[side] && !isDesktopSim) {
            handsState[side].active = false;
            if (handsState[side].visualGroup) {
                handsState[side].visualGroup.visible = false;
            }
            if (projectedHands[side]) {
                projectedHands[side].group.visible = false;
            }
        }
    });

    // B. Desktop Simulator (Right Hand)
    if (isDesktopSim && !hardwareHandsFound.left && !hardwareHandsFound.right) {
        const handState = handsState.right;
        handState.active = true;

        const simWorldPos = simHandPos.clone().applyQuaternion(camera.quaternion).add(headPos);
        handState.palmPos.copy(simWorldPos);

        const metrics = calculateHandFOV(headPos, headForward, handState.palmPos);
        handState.subtendedAngleDeg = metrics.angleDeg;
        handState.lastValidAngleDeg = metrics.angleDeg;
        handState.distance = metrics.distance;
        handState.elevationDeg = metrics.elevationDeg;
        handState.azimuthDeg = metrics.azimuthDeg;

        updateVisualizer('right', headPos, headForward, handState.palmPos, metrics);

        if (handsState.left.visualGroup) handsState.left.visualGroup.visible = false;
        handsState.left.active = false;
    }

    // Update the second hand rendering in front of user
    updateProjectedHands(headPos, headForward);

    // Update HTML UI metrics
    if (handsState.left.active) {
        metricLeftAngle.textContent = `${handsState.left.subtendedAngleDeg.toFixed(1)}° (${(handsState.left.distance * 100).toFixed(0)}cm)`;
        metricLeftAngle.style.color = '#58a6ff';
    } else if (handsState.left.lastValidAngleDeg !== null) {
        metricLeftAngle.textContent = `${handsState.left.lastValidAngleDeg.toFixed(1)}° TRACKING_LOST`;
        metricLeftAngle.style.color = '#f85149';
    } else {
        metricLeftAngle.textContent = '-- TRACKING_LOST';
        metricLeftAngle.style.color = '#f85149';
    }

    if (handsState.right.active) {
        metricRightAngle.textContent = `${handsState.right.subtendedAngleDeg.toFixed(1)}° (${(handsState.right.distance * 100).toFixed(0)}cm)`;
        metricRightAngle.style.color = '#3fb950';
    } else if (handsState.right.lastValidAngleDeg !== null) {
        metricRightAngle.textContent = `${handsState.right.lastValidAngleDeg.toFixed(1)}° TRACKING_LOST`;
        metricRightAngle.style.color = '#f85149';
    } else {
        metricRightAngle.textContent = '-- TRACKING_LOST';
        metricRightAngle.style.color = '#f85149';
    }

    const anyActive = handsState.left.active || handsState.right.active;
    if (anyActive) {
        metricTrackingStatus.textContent = isDesktopSim ? 'Simulated Hand Active (Desktop)' : 'Hardware Hand Tracked';
        metricTrackingStatus.style.color = '#3fb950';
    } else {
        metricTrackingStatus.textContent = 'Tracking Lost (No Hands in FOV)';
        metricTrackingStatus.style.color = '#f85149';
    }

    updateHUD();
}

function render(time, frame) {
    updateTrackingAndMetrics(frame);
    // 100% native standard WebXR stereo pipeline
    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
