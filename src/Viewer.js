import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';
import { PlyLoader } from './PlyLoader.js';
import { SplatLoader } from './SplatLoader.js';
import { SplatBuffer } from './SplatBuffer.js';
import { createNodeSortWorker } from './NodeSortWorker.js';
import { LoadingSpinner } from './LoadingSpinner.js';
import { Octree } from './octree/Octree.js';

const DEFAULT_CAMERA_SPECS = {
    'fx': 1159.5880733038064,
    'fy': 1164.6601287484507,
    'near': 0.1,
    'far': 500
};

export class Viewer {

    constructor(rootElement = null, cameraUp = [0, 1, 0], initialCameraPos = [0, 10, 15], initialCameraLookAt = [0, 0, 0],
                cameraSpecs = DEFAULT_CAMERA_SPECS, controls = null, selfDrivenMode = true) {
        this.rootElement = rootElement;
        this.cameraUp = new THREE.Vector3().fromArray(cameraUp);
        this.initialCameraPos = new THREE.Vector3().fromArray(initialCameraPos);
        this.initialCameraLookAt = new THREE.Vector3().fromArray(initialCameraLookAt);
        this.cameraSpecs = cameraSpecs;
        this.controls = controls;
        this.selfDrivenMode = selfDrivenMode;
        this.scene = null;
        this.camera = null;
        this.realProjectionMatrix = new THREE.Matrix4();
        this.renderer = null;
        this.selfDrivenUpdateFunc = this.update.bind(this);
        this.resizeFunc = this.onResize.bind(this);
        this.sortWorker = null;

        this.workerTransferCenterCovarianceBuffer = null;
        this.workerTransferColorBuffer = null;
        this.workerTransferCenterCovarianceArray = null;
        this.workerTransferColorArray = null;

        this.octree = null;
        this.octreeNodeMap = {};

        this.nodesToSort = [];
        this.currentlySorting = false;
    }

    getRenderDimensions(outDimensions) {
        outDimensions.x = this.rootElement.offsetWidth;
        outDimensions.y = this.rootElement.offsetHeight;
    }

    updateRealProjectionMatrix(renderDimensions) {
        this.realProjectionMatrix.elements = [
            [(2 * this.cameraSpecs.fx) / renderDimensions.x, 0, 0, 0],
            [0, (2 * this.cameraSpecs.fy) / renderDimensions.y, 0, 0],
            [0, 0, -(this.cameraSpecs.far + this.cameraSpecs.near) / (this.cameraSpecs.far - this.cameraSpecs.near), -1],
            [0, 0, -(2.0 * this.cameraSpecs.far * this.cameraSpecs.near) / (this.cameraSpecs.far - this.cameraSpecs.near), 0],
        ].flat();
    }
    onResize = function() {

        const renderDimensions = new THREE.Vector2();

        return function() {
            this.renderer.setSize(1, 1);
            this.getRenderDimensions(renderDimensions);
            this.camera.aspect = renderDimensions.x / renderDimensions.y;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(renderDimensions.x, renderDimensions.y);
            this.updateRealProjectionMatrix(renderDimensions);
            this.updateAllSplatMeshUniforms();
        };

    }();

    init() {

        if (!this.rootElement) {
            this.rootElement = document.createElement('div');
            this.rootElement.style.width = '100%';
            this.rootElement.style.height = '100%';
            document.body.appendChild(this.rootElement);
        }

        const renderDimensions = new THREE.Vector2();
        this.getRenderDimensions(renderDimensions);

        this.camera = new THREE.PerspectiveCamera(70, renderDimensions.x / renderDimensions.y, 0.1, 500);
        this.camera.position.copy(this.initialCameraPos);
        this.camera.lookAt(this.initialCameraLookAt);
        this.camera.up.copy(this.cameraUp).normalize();
        this.updateRealProjectionMatrix(renderDimensions);

        this.scene = new THREE.Scene();

        this.renderer = new THREE.WebGLRenderer({
            antialias: false
        });
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setSize(renderDimensions.x, renderDimensions.y);

        if (!this.controls) {
            this.controls = new OrbitControls(this.camera, this.renderer.domElement);
            this.controls.maxPolarAngle = (0.9 * Math.PI) / 2;
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.15;
            this.controls.target.copy(this.initialCameraLookAt);
        }

        window.addEventListener('resize', this.resizeFunc, false);

        this.rootElement.appendChild(this.renderer.domElement);

        this.sortWorker = new Worker(
            URL.createObjectURL(
                new Blob(['(', createNodeSortWorker.toString(), ')(self)'], {
                    type: 'application/javascript',
                }),
            ),
        );

        this.sortWorker.onmessage = (e) => {
            if (e.data.sortDone) {
                const node = this.octreeNodeMap[e.data.id];
                this.updateSplatMeshAttributes(node, this.workerTransferColorArray, this.workerTransferCenterCovarianceArray);
                this.updateSplatMeshUniforms(node);
                this.currentlySorting = false;
            }
        };
    }

    updateSplatMeshAttributes(node, colors, centerCovariances) {
        const vertexCount = node.data.splatBuffer.getVertexCount();
        if (vertexCount > 0) {
            const geometry = node.data.splatMesh.geometry;
    
            geometry.attributes.splatCenterCovariance.set(centerCovariances);
            geometry.attributes.splatCenterCovariance.needsUpdate = true;
    
            geometry.attributes.splatColor.set(colors);
            geometry.attributes.splatColor.needsUpdate = true;
    
            geometry.instanceCount = vertexCount;
        }
    }

    updateAllSplatMeshUniforms = function () {
        for (let nodeID in this.octreeNodeMap) {
            const node = this.octreeNodeMap[nodeID];
            this.updateSplatMeshUniforms(node);
        }
    }

    updateSplatMeshUniforms = function() {

        const renderDimensions = new THREE.Vector2();

        return function(node) {
            const vertexCount = node.data.splatBuffer.getVertexCount();
            if (vertexCount > 0) {
                this.getRenderDimensions(renderDimensions);
                node.data.splatMesh.material.uniforms.realProjectionMatrix.value.copy(this.realProjectionMatrix);
                node.data.splatMesh.material.uniforms.focal.value.set(this.cameraSpecs.fx, this.cameraSpecs.fy);
                node.data.splatMesh.material.uniforms.viewport.value.set(renderDimensions.x, renderDimensions.y);
                node.data.splatMesh.material.uniformsNeedUpdate = true;
            }
        };

    }();

    loadFile(fileName) {
        const loadingSpinner = new LoadingSpinner();
        loadingSpinner.show();
        const loadPromise = new Promise((resolve, reject) => {
            let fileLoadPromise;
            if (fileName.endsWith('.splat')) {
                fileLoadPromise = new SplatLoader().loadFromFile(fileName);
            } else if (fileName.endsWith('.ply')) {
                fileLoadPromise = new PlyLoader().loadFromFile(fileName);
            } else {
                reject(new Error(`Viewer::loadFile -> File format not supported: ${fileName}`));
            }
            fileLoadPromise
            .then((splatBuffer) => {
                resolve(splatBuffer);
            })
            .catch((e) => {
                reject(new Error(`Viewer::loadFile -> Could not load file ${fileName}`));
            });
        });

        return loadPromise.then((splatBuffer) => {

            this.octree = new Octree(2);
            console.time("Octree build");
            this.octree.processScene(splatBuffer);
            console.timeEnd("Octree build");

            console.log("Octree leaves: " + this.octree.countLeaves());
            console.log("Octree leaves with vertices: " + this.octree.countLeavesWithVertices());
            let avgVertexCount = 0;
            let maxVertexCount = 0;
            let nodeCount = 0;
            this.octree.visitLeaves((node) => {
                const vertexCount = node.data.splatBuffer.getVertexCount();
                if (vertexCount > 0) {
                    this.octreeNodeMap[node.id] = node;
                    avgVertexCount += vertexCount;
                    maxVertexCount = Math.max(maxVertexCount, vertexCount);
                    nodeCount++;
                    node.data.splatBuffer.buildPreComputedBuffers();
                    node.data.splatMesh = this.buildMesh(node.data.splatBuffer);
                    node.data.splatMesh.frustumCulled = false;
                    this.scene.add(node.data.splatMesh);

                    const {colors, centerCovariances} =  this.getAttributeDataFromSplatBuffer(node.data.splatBuffer);
                    const geometry = node.data.splatMesh.geometry;
                    geometry.attributes.splatCenterCovariance.set(centerCovariances);
                    geometry.attributes.splatCenterCovariance.needsUpdate = true;
                    geometry.attributes.splatColor.set(colors);
                    geometry.attributes.splatColor.needsUpdate = true;
                    geometry.instanceCount = vertexCount;
                }
            });
            this.updateAllSplatMeshUniforms();
            avgVertexCount /= nodeCount;
            console.log("Avg vertex count per node: " + avgVertexCount);

            this.workerTransferCenterCovarianceBuffer = new SharedArrayBuffer(maxVertexCount * 9 * 4);
            this.workerTransferColorBuffer = new SharedArrayBuffer(maxVertexCount * 4 * 4)
            this.workerTransferCenterCovarianceArray = new Float32Array(this.workerTransferCenterCovarianceBuffer);
            this.workerTransferColorArray = new Float32Array(this.workerTransferColorBuffer);
            loadingSpinner.hide();

        });
    }

    addDebugMeshesToScene() {
        const sphereGeometry = new THREE.SphereGeometry(1, 32, 32);

        let sphereMesh = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({color: 0xff0000}));
        this.scene.add(sphereMesh);
        sphereMesh.position.set(-50, 0, 0);

        sphereMesh = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({color: 0xff0000}));
        this.scene.add(sphereMesh);
        sphereMesh.position.set(50, 0, 0);

        sphereMesh = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({color: 0x00ff00}));
        this.scene.add(sphereMesh);
        sphereMesh.position.set(0, 0, -50);

        sphereMesh = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({color: 0x00ff00}));
        this.scene.add(sphereMesh);
        sphereMesh.position.set(0, 0, 50);
    }

    sortSceneNodes = function() {

        const sortList = [];
        const tempVectorA = new THREE.Vector3();
        const tempVectorB = new THREE.Vector3();

        const sorted = {};

        return function () {

            this.renderer.sortObjects = true;

            let index = 0;
            this.octree.visitLeaves((node) => {
                const vertexCount = node.data.splatBuffer.getVertexCount();
                if (vertexCount > 0) {
                    sortList[index] = node;
                    index++;
                }
            });

            sortList.sort((a, b) => {
                tempVectorA.copy(a.center).sub(this.camera.position);
                tempVectorB.copy(b.center).sub(this.camera.position);
                if(tempVectorA.lengthSq() > tempVectorB.lengthSq()) {
                    return 1;
                } else {
                    return -1;
                }
            });

            let renderOrder = 0;
            for (let node of sortList) {
                node.data.splatMesh.renderOrder = renderOrder;
                renderOrder++;
            }

            for (let node of sortList) {
                if (!sorted[node.id]) {
                    this.nodesToSort.push(node);
                    sorted[node.id] = true;
                    break;
                }
            }

        };

    }();

    start() {
        if (this.selfDrivenMode) {
            requestAnimationFrame(this.selfDrivenUpdateFunc);
        } else {
            throw new Error('Cannot start viewer unless it is in self driven mode.');
        }
    }

    update() {
        if (this.selfDrivenMode) {
            requestAnimationFrame(this.selfDrivenUpdateFunc);
        }
        this.controls.update();
        this.sortSceneNodes();
        if (!this.currentlySorting) {
            if (this.nodesToSort.length > 0) {
                const node = this.nodesToSort.shift();
                this.updateSortWorkerForNode(node);
                this.currentlySorting = true;
            }
        }
        this.renderer.autoClear = false;
        this.renderer.render(this.scene, this.camera);
    }

    updateSortWorkerForNode = function() {

        const tempMatrix = new THREE.Matrix4();
        const tempVector2 = new THREE.Vector2();
        const cameraPositionArray = [];

        return function(node) {

            this.getRenderDimensions(tempVector2);
            tempMatrix.copy(this.camera.matrixWorld).invert();
            tempMatrix.premultiply(this.realProjectionMatrix);
            cameraPositionArray[0] = this.camera.position.x;
            cameraPositionArray[1] = this.camera.position.y;
            cameraPositionArray[2] = this.camera.position.z;

            const vertexCount = node.data.splatBuffer.getVertexCount();
            this.workerTransferCenterCovarianceArray = new Float32Array(this.workerTransferCenterCovarianceBuffer, 0, vertexCount);
            this.workerTransferColorArray = new Float32Array(this.workerTransferColorBuffer, 0, vertexCount);

            this.sortWorker.postMessage({
                sort: {
                    'rowSizeFloats': SplatBuffer.RowSizeFloats,
                    'rowSizeBytes': SplatBuffer.RowSizeBytes,
                    'splatBuffer': node.data.splatBuffer.getBufferData(),
                    'workerTransferCenterCovarianceBuffer': this.workerTransferCenterCovarianceBuffer,
                    'workerTransferColorBuffer': this.workerTransferColorBuffer,
                    'precomputedCovariance': node.data.splatBuffer.getPrecomputedCovarianceBufferData(),
                    'precomputedColor': node.data.splatBuffer.getPrecomputedColorBufferData(),
                    'vertexCount': vertexCount,
                    'view': tempMatrix.elements,
                    'cameraPosition': cameraPositionArray,
                    'id': node.id
                }
            });
        };

    }();

    buildMaterial() {

        const vertexShaderSource = `
            #include <common>
            precision mediump float;

            attribute vec4 splatColor;
            attribute mat3 splatCenterCovariance;

            uniform mat4 realProjectionMatrix;
            uniform vec2 focal;
            uniform vec2 viewport;

            varying vec4 vColor;
            varying vec2 vPosition;
            varying vec2 vUv;
            varying vec4 conicOpacity;

            void main () {

            vec3 splatCenter = splatCenterCovariance[0];
            vec3 cov3D_M11_M12_M13 = splatCenterCovariance[1];
            vec3 cov3D_M22_M23_M33 = splatCenterCovariance[2];

            vec4 camspace = viewMatrix * vec4(splatCenter, 1);
            vec4 pos2d = realProjectionMatrix * camspace;

            float bounds = 1.2 * pos2d.w;
            if (pos2d.z < -pos2d.w || pos2d.x < -bounds || pos2d.x > bounds
                || pos2d.y < -bounds || pos2d.y > bounds) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                return;
            }
 
            mat3 Vrk = mat3(
                cov3D_M11_M12_M13.x, cov3D_M11_M12_M13.y, cov3D_M11_M12_M13.z,
                cov3D_M11_M12_M13.y, cov3D_M22_M23_M33.x, cov3D_M22_M23_M33.y,
                cov3D_M11_M12_M13.z, cov3D_M22_M23_M33.y, cov3D_M22_M23_M33.z
            );

            mat3 J = mat3(
                focal.x / camspace.z, 0., -(focal.x * camspace.x) / (camspace.z * camspace.z),
                0., focal.y / camspace.z, -(focal.y * camspace.y) / (camspace.z * camspace.z),
                0., 0., 0.
            );

            mat3 W = transpose(mat3(viewMatrix));
            mat3 T = W * J;
            mat3 cov2Dm = transpose(T) * Vrk * T;
            cov2Dm[0][0] += 0.3;
            cov2Dm[1][1] += 0.3;
            vec3 cov2Dv = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);


            vec2 vCenter = vec2(pos2d) / pos2d.w;

            float diagonal1 = cov2Dv.x;
            float offDiagonal = cov2Dv.y;
            float diagonal2 = cov2Dv.z;

            float mid = 0.5 * (diagonal1 + diagonal2);
            float radius = length(vec2((diagonal1 - diagonal2) / 2.0, offDiagonal));
            float lambda1 = mid + radius;
            float lambda2 = max(mid - radius, 0.1);
            vec2 diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1));
            vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
            vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

            vColor = splatColor;
            vPosition = position.xy;

            vec2 projectedCovariance = vCenter +
                                       position.x * v1 / viewport * 2.0 +
                                       position.y * v2 / viewport * 2.0;

            gl_Position = vec4(projectedCovariance, 0.0, 1.0);

        }`;

        const fragmentShaderSource = `
            #include <common>
            precision mediump float;

            uniform vec3 debugColor;

            varying vec4 vColor;
            varying vec2 vPosition;
            varying vec4 conicOpacity;
            varying vec2 vUv;

            vec3 gamma(vec3 value, float param) {
                return vec3(pow(abs(value.r), param),pow(abs(value.g), param),pow(abs(value.b), param));
            }  

            void main () {
                float A = -dot(vPosition, vPosition);
                if (A < -4.0) discard;
                vec3 color = vColor.rgb;
                float alpha = vColor.a;

                //color = color / (color + vec3(1.0));
                //color = pow(color, vec3(1.0/1.5));  
                //color = saturate(mix(vec3(0.5, 0.5, 0.5), color, 1.01));

                float B = exp(A) * alpha;
                vec3 colorB = B * color.rgb;

                // colorB = pow(colorB, vec3(2.2));
                // colorB = saturate(mix(vec3(0.5, 0.5, 0.5), colorB, 1.0001));
                // colorB = pow(colorB, vec3(1.0/2.2));
  
                gl_FragColor = vec4(colorB, B);

            }`;

        const uniforms = {
            'realProjectionMatrix': {
                'type': 'v4v',
                'value': new THREE.Matrix4()
            },
            'focal': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'viewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'debugColor': {
                'type': 'v3',
                'value': new THREE.Color()
            },
        };

        return new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: true,
            alphaTest: 1.0,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneMinusDstAlphaFactor,
            blendDst: THREE.OneFactor,
            blendSrcAlpha: THREE.OneMinusDstAlphaFactor,
            blendDstAlpha: THREE.OneFactor,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        });
    }

    buildGeomtery(splatBuffer) {

        const baseGeometry = new THREE.BufferGeometry();

        const positionsArray = new Float32Array(18);
        const positions = new THREE.BufferAttribute(positionsArray, 3);
        baseGeometry.setAttribute('position', positions);
        positions.setXYZ(2, -2.0, 2.0, 0.0);
        positions.setXYZ(1, -2.0, -2.0, 0.0);
        positions.setXYZ(0, 2.0, 2.0, 0.0);
        positions.setXYZ(5, -2.0, -2.0, 0.0);
        positions.setXYZ(4, 2.0, -2.0, 0.0);
        positions.setXYZ(3, 2.0, 2.0, 0.0);
        positions.needsUpdate = true;

        const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);

        const splatColorsArray = new Float32Array(splatBuffer.getVertexCount() * 4);
        const splatColors = new THREE.InstancedBufferAttribute(splatColorsArray, 4, false);
        splatColors.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatColor', splatColors);

        const splatCentersArray = new Float32Array(splatBuffer.getVertexCount() * 9);
        const splatCenters = new THREE.InstancedBufferAttribute(splatCentersArray, 9, false);
        splatCenters.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatCenterCovariance', splatCenters);

        return geometry;
    }

    buildMesh(splatBuffer) {
        const geometry = this.buildGeomtery(splatBuffer);
        const material = this.buildMaterial();
        const mesh = new THREE.Mesh(geometry, material);
        return mesh;
    }

    getAttributeDataFromSplatBuffer (splatBuffer) {

        const vertexCount = splatBuffer.getVertexCount();

        const splatArray = new Float32Array(splatBuffer.getBufferData());
        const pCovarianceArray = new Float32Array(splatBuffer.getPrecomputedCovarianceBufferData());
        const pColorArray = new Float32Array(splatBuffer.getPrecomputedColorBufferData());
        const color = new Float32Array(vertexCount * 4);
        const centerCov = new Float32Array(vertexCount * 9);

        for (let i = 0; i < vertexCount; i++) {

            const centerCovBase = 9 * i;
            const pCovarianceBase = 6 * i;
            const colorBase = 4 * i;
            const pcColorBase = 4 * i;
            const splatArrayBase = SplatBuffer.RowSizeFloats * i;

            centerCov[centerCovBase] = splatArray[splatArrayBase];
            centerCov[centerCovBase + 1] = splatArray[splatArrayBase + 1];
            centerCov[centerCovBase + 2] = splatArray[splatArrayBase + 2];

            color[colorBase] = pColorArray[pcColorBase];
            color[colorBase + 1] = pColorArray[pcColorBase + 1];
            color[colorBase + 2] = pColorArray[pcColorBase + 2];
            color[colorBase + 3] = pColorArray[pcColorBase + 3];

            centerCov[centerCovBase + 3] = pCovarianceArray[pCovarianceBase];
            centerCov[centerCovBase + 4] = pCovarianceArray[pCovarianceBase + 1];
            centerCov[centerCovBase + 5] = pCovarianceArray[pCovarianceBase + 2];
            centerCov[centerCovBase + 6] = pCovarianceArray[pCovarianceBase + 3];
            centerCov[centerCovBase + 7] = pCovarianceArray[pCovarianceBase + 4];
            centerCov[centerCovBase + 8] = pCovarianceArray[pCovarianceBase + 5];
        }

        return {
            'colors': color,
            'centerCovariances': centerCov
        }

    };
}
