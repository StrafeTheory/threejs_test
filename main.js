import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

//EXTRA: for smooth lasso drawing we can draw default buffer to a saved render target, and draw lasso on top of that pre rendererd background (although this will stop us from being able to highlight objects on the fly) 
//

const debug = false;


const eSelectMode = {
    SELECT: 1,
    LASSO: 2
};

const eEditMode = {
    OBJECT: 1,
    VERTEX: 2
};

const eSnapMode = {
    FACE: 1,
    VERTEX: 2,
};

const eState = {
    SELECT: 0,
    SNAP: 1,
    JOIN_SELECT_VERTEX1: 2,
    JOIN_SELECT_VERTEX2: 3
};

let should_update_render = false;

function node_destroy(node)
{
    if (node.geometry !== undefined) {
        // check if geometry is referenced by other nodes to skip deleting
        let geo_is_refd = false;
        editor.scene.traverse((obj) => {
            if (obj !== node && obj.geometry === node.geometry) {
                geo_is_refd = true;
            }
        });

        if (!geo_is_refd) {
            node.geometry.dispose();
        }
    }
    node.parent.remove(node);
}

function node_create_verts_drawing(node)
{
    node_destroy_verts_drawing(node);
    const verts_geo = new THREE.BufferGeometry();
    // clone vertices from original geo
    const verts_pos_attr = node.geometry.getAttribute('position').clone();
    verts_geo.setAttribute('position', verts_pos_attr);

    const colors_f32 = new Float32Array(verts_pos_attr.count * 3);
    const color_attr = new THREE.BufferAttribute(colors_f32, 3, false);
    verts_geo.setAttribute('color', color_attr);
    for (let vi = 0; vi < color_attr.count; ++vi) {
        color_attr.setXYZ(vi, 1.0,1.0,1.0);
    }

    node.verts_drawing = new THREE.Points(verts_geo, editor.mat_points);
    // NOTE: remove points from raycast
    node.verts_drawing.raycast = () => {};
    // draw on top
    node.verts_drawing.renderOrder = 1;
    node.add(node.verts_drawing);

}

function node_destroy_verts_drawing(node)
{
    if (node.verts_drawing === undefined) {
        return;
    }
    node_destroy(node.verts_drawing);
    node.verts_drawing = undefined;

}

function highlight_verts(node, indices)
{
    if (node.verts_drawing === undefined) {
        return;
    }

    const vcolor_attr = node.verts_drawing.geometry.getAttribute('color');
    for (let ii = 0; ii < indices.length; ++ii) {
        const vi = indices[ii];
        vcolor_attr.setXYZ(vi, 1.0,1.0,0.0);
    }
    vcolor_attr.needsUpdate = true;
}

function start_perf_ms()
{
    return Date.now();
}

function end_perf_ms(start)
{
    return Date.now() - start;
}

class Editor {
    constructor() {
        this.obj_count = 0;
        this.objects = [];

        this.select_mode = eSelectMode.SELECT;
        this.edit_mode = eEditMode.OBJECT;
        this.snap_mode = eSnapMode.FACE;
        this.should_snap_align_rotation = false;

        this.selected_nodes = [];

        this.mat_selected = new THREE.MeshBasicMaterial({
            color: 0x505050,
            wireframe: true });

        this.scene = undefined;
        this.state = eState.SELECT;

        this.og_quat_before_snap = undefined;

        this.mat_points = new THREE.PointsMaterial({
            size:0.01,
            color: 0xFFFFFF,
            vertexColors:true,
            depthTest:false});

    }

    count_selected_verts() {
        let count = 0;
        for (let i = 0; i < this.selected_nodes.length; ++i) {
            const node = this.selected_nodes[i];
            if (node.selected_indices === undefined) {
                continue;
            }
            count += node.selected_indices.length;
        }
        return count;
    }

    clear_selected() {
        g.tform_gizmo.detach();

        for (const node of this.selected_nodes) {
            node_destroy_verts_drawing(node);
            node.is_selected = false;
            node.material = node.og_mat;
            node.selected_indices = undefined;
        }

        this.selected_nodes.length = 0;
        this.edit_mode = eEditMode.OBJECT;
    }

    switch_to_object_mode() {
        if (this.edit_mode === eEditMode.VERTEX) {
            for (const node of this.selected_nodes) {
                node_destroy_verts_drawing(node);
            }
        }
        this.edit_mode = eEditMode.OBJECT;
        if (this.selected_nodes !== undefined
            && this.selected_nodes.length === 1) {
            g.tform_gizmo.attach(this.selected_nodes[0]);
        }
    }

    select_node(node) {
        if (node.is_selected) {
            return;
        }
        node.is_selected = true;
        node.og_mat = node.material;
        node.material = this.mat_selected;
        this.selected_nodes.push(node);

        if (this.selected_nodes.length == 1) {
            g.tform_gizmo.attach(node);
        } else {
            g.tform_gizmo.detach();
        }

    }

    mouse_pick_node() {
        if (this.scene === undefined) {
            return [];
        }
        const recursive = true;
        const results = raycaster.intersectObjects(
            this.scene.children, recursive);

        return results;
    }

    merge_selected_verts() {
        console.assert(this.selected_nodes !== undefined);
        console.assert(this.selected_nodes.length === 1);

        const node = this.selected_nodes[0];
        console.assert(node.selected_indices.length >= 2);

        const geo = node.geometry;

        const idx0 = node.selected_indices[0];
        const idx1 = node.selected_indices[1];

        if (geo.index !== undefined) {
            // update old indices pointing at idx0 to now point to idx1
            const array = geo.index.array;
            for (let i = 0; i < array.length; ++i) {
                if (array[i] == idx0) {
                    array[i] = idx1;
                }
            }
            geo.index.needsUpdate = true;
        } else {
            //TODO: need test case for non-indexed triangles
        }

        node_destroy_verts_drawing(node);
        node.selected_indices = undefined;

    }

    begin_merge_vertex_mode() {
        if (this.selected_nodes.length !== 1) {
            console.warn('Must have object selected to merge vertex');
            this.edit_mode = eEditMode.OBJECT;
            return;
        }

        this.state = eState.JOIN_SELECT_VERTEX1;

        const node = this.selected_nodes[0];
        node.selected_indices = undefined;
        node_create_verts_drawing(node);
        g.tform_gizmo.detach();
        g.cam_controls.enabled = false;
    }

    end_merge_vertex_mode() {
        this.state = eState.SELECT;
        const node = this.selected_nodes[0];
        g.tform_gizmo.attach(node);
        g.cam_controls.enabled = true;
    }

    setup_vertex_mode() {
        if (this.selected_nodes.length <= 0) {
            console.warn('Must have object selected to edit vertices');
            this.edit_mode = eEditMode.OBJECT;
            return;
        }

        this.edit_mode = eEditMode.VERTEX;

        const node = this.selected_nodes[0];
        node_create_verts_drawing(node);

        g.tform_gizmo.detach();

        on_render();
    }

    setup_lasso_mode() {
        this.state = eState.SELECT;
        this.select_mode = eSelectMode.LASSO;
        g.cam_controls.enabled = false;
        g.tform_gizmo.detach();
    }

    setup_select_mode() {
        this.state = eState.SELECT;
        this.select_mode = eSelectMode.SELECT;
        g.cam_controls.enabled = true;
    }

    begin_snap() {
        //NOTE: only allow snapping 1 node/group
        if (this.selected_nodes.length != 1) {
            this.state = eState.SELECT;
            return;
        }

        this.state = eState.SNAP;

        const node = this.selected_nodes[0];
        g.tform_gizmo.detach();

        this.og_quat_before_snap = new THREE.Quaternion();
        node.getWorldQuaternion(this.og_quat_before_snap);
    }

    end_snap() {
        this.state = eState.SELECT;
        const node = this.selected_nodes[0];
        g.tform_gizmo.attach(node);
        this.og_quat_before_snap = undefined;
    }

    process_lasso_region() {

        if (lasso.point_count >= 3 && this.scene !== undefined) {
            if (this.state === eState.JOIN_SELECT_VERTEX1
                || this.state === eState.JOIN_SELECT_VERTEX2) {

                const node = this.selected_nodes[0];
                //NOTE: only grab first index we find
                const hl_indices = lasso_vs_node(node, true);
                if (node.selected_indices === undefined) {
                    node.selected_indices = hl_indices;
                } else {
                    node.selected_indices = node.selected_indices.concat(hl_indices);
                }
                highlight_verts(node, node.selected_indices);

            } else {
                if (this.edit_mode === eEditMode.OBJECT) {
                    // lasso vs editor objects
                    if (debug) {
                        dlines.clear();
                        dlines.add_box2(lasso.bbox2_vp, new THREE.Color().setHex(0xFF00FF));
                    }
                    lasso_vs_nodes(this.scene.children);
                } else {
                    // lasso vs selected nodes verts
                    const node = this.selected_nodes[0];
                    node.selected_indices = lasso_vs_node(node, false);

                    highlight_verts(node, node.selected_indices);
                }
            }
        }

    }

    on_pointerdown() {
        if (this.state == eState.SNAP) {
            // nothing
        } else if (this.state === eState.SELECT) {
            if (this.select_mode===eSelectMode.LASSO) {
                g.cam_controls.enabled = false;
                g.tform_gizmo.detach();
                lasso.begin_new_selection();
            }
        } else if (this.state === eState.JOIN_SELECT_VERTEX1
            || this.state === eState.JOIN_SELECT_VERTEX2) {
            lasso.begin_new_selection();
        }
    }

    on_pointerup() {
        if (this.state == eState.SNAP) {
            this.end_snap();
        } else if (this.state === eState.SELECT) {
            if (this.select_mode === eSelectMode.LASSO) {
                this.process_lasso_region();
                lasso.end_selection();
                this.setup_select_mode();

            } else {
                // click to select object
                if (this.edit_mode == eEditMode.OBJECT) {
                    const mouse_ndc = vec2_vp_to_ndc(input.mouse);
                    raycaster.setFromCamera(mouse_ndc, g.cam);

                    const results = this.mouse_pick_node();
                    if (results.length > 0) {
                        const obj = results[0].object;
                        this.select_node(obj);
                    }
                }
            }
        } else if (this.state === eState.JOIN_SELECT_VERTEX1
            || this.state === eState.JOIN_SELECT_VERTEX2) {
            this.process_lasso_region();
            lasso.end_selection();

            const node = this.selected_nodes[0];

            if (this.state === eState.JOIN_SELECT_VERTEX2) {
                if (node.selected_indices.length === 2) {
                    this.merge_selected_verts();
                    this.end_merge_vertex_mode();
                }
            } else {
                if (node.selected_indices !== undefined 
                    && node.selected_indices.length === 1) {
                    this.state = eState.JOIN_SELECT_VERTEX2;
                }
            }
        }
    }

    on_pointermove() {
        if (this.scene === undefined) {
            return;
        }

        if (this.state == eState.SNAP) {
            const node = this.selected_nodes[0];

            const recursive = true;
            const results = raycaster.intersectObjects(
                this.scene.children, recursive);

            for (let ri = 0; ri < results.length; ++ri) {
                const hit = results[ri];
                //NOTE: don't snap node to itself
                if (hit.object !== node) {
                    // set new position of node based off faces or nearest vertex
                    //
                    if (this.snap_mode == eSnapMode.FACE) {
                        //NOTE: hit.point is in world space, convert to local
                        const new_pos = hit.point.clone();
                        // position relative to parent
                        node.parent.worldToLocal(new_pos);
                        node.position.copy(new_pos);
                    } else {
                        //find closest vertex on face to hit point to snap to
                        let new_dist = Number.MAX_VALUE;
                        const new_pos = new THREE.Vector3();
                        const indices = [hit.face.a, hit.face.b, hit.face.c];
                        for (let ii = 0; ii < indices.length; ++ii) {
                            const pos = new THREE.Vector3().fromBufferAttribute(
                                hit.object.geometry.attributes.position, indices[ii]);
                            // get vertex pos in world space
                            hit.object.localToWorld(pos);
                            const dist = pos.distanceToSquared(hit.point);
                            if (dist < new_dist) {
                                new_dist = dist;
                                new_pos.copy(pos);
                            }
                        }

                        //NOTE: hit.point is in world space
                        // convert to local since position is relative to parent
                        node.parent.worldToLocal(new_pos);
                        node.position.copy(new_pos);
                    }

                    // align rotation of node to match target
                    if (editor.should_snap_align_rotation) {
                        //NOTE: hit normal is in hit.object local space, convert to worldspace
                        const hit_normal_ws = hit.face.normal.clone();
                        hit_normal_ws.transformDirection(hit.object.matrixWorld);

                        const node_up = new THREE.Vector3(0,1,0);
                        // rotate to our new normal direction
                        const quat_to_new_up = new THREE.Quaternion().setFromUnitVectors(
                            node_up, hit_normal_ws);

                        node.quaternion.multiplyQuaternions(quat_to_new_up, this.og_quat_before_snap);
                        node.quaternion.normalize();
                    }

                    should_update_render = true;
                    break;
                }
            }


        } else if (this.state === eState.SELECT) {
            if (this.select_mode === eSelectMode.LASSO) {
                if (lasso.is_drawing && lasso.add_point()) {
                    should_update_render = true;
                }
            }
        } else if (this.state === eState.JOIN_SELECT_VERTEX1
            || this.state === eState.JOIN_SELECT_VERTEX2) {

            if (lasso.is_drawing && lasso.add_point()) {
                should_update_render = true;
            }
        }
    }

    split_selected_node() {
        if (this.selected_nodes.length !== 1) {
            console.warn('Splitting requires 1 object to be selected');
            return;
        }

        const node = this.selected_nodes[0];
        split_node_geo(node);
    }

    join_selected_nodes() {
        if (this.selected_nodes.length !== 2) {
            console.warn('You must have 2 nodes selected in order to join');
            return;
        }

        const node0 = this.selected_nodes[0];
        const node1 = this.selected_nodes[1];

        //XXX: this join code currently assumes both meshes have a single material (no groups)

        // NOTE: meshes could have different parents and not be part of same transform hierarchy, so we will bring geometry into world space and add new merged node at root level
        // NOTE: create clones of geo to modify in case other nodes reference original geo
        const node0_geo = node0.geometry.clone();
        node0_geo.applyMatrix4(node0.matrixWorld);
        const node1_geo = node1.geometry.clone();
        node1_geo.applyMatrix4(node1.matrixWorld);

        const geo_merged = BufferGeometryUtils.mergeGeometries(
            [node0_geo, node1_geo],
            true);

        node0_geo.dispose();
        node1_geo.dispose();

        const node_merged = new THREE.Mesh(
            geo_merged, 
            [node0.og_mat, node1.og_mat]);

        editor.scene.add(node_merged);

        //NOTE: clear selected before destroying
        this.clear_selected();

        node_destroy(node0);
        node_destroy(node1);
    }
};

function node_create_new_geometry_with_indices(geo, indices)
{
    const unique_indices = Array.from(new Set(indices));
    const new_vert_count = unique_indices.length;
    const indices_map = new Map();

    const new_geo = new THREE.BufferGeometry();

    // recreate buffer attributes for position/normal so they only contain our new set of indices
    const new_pos_array = new Float32Array(new_vert_count * 3);
    const og_pos_array = geo.getAttribute('position').array;
    for (let i = 0; i < unique_indices.length; ++i) {
        const old_idx = unique_indices[i];
        const new_idx = i;
        indices_map.set(old_idx, new_idx);
        new_pos_array[new_idx*3] = og_pos_array[old_idx*3];
        new_pos_array[new_idx*3 + 1] = og_pos_array[old_idx*3 + 1];
        new_pos_array[new_idx*3 + 2] = og_pos_array[old_idx*3 + 2];
    }

    const new_pos_attr = new THREE.BufferAttribute(new_pos_array, 3);
    new_geo.setAttribute('position', new_pos_attr);


    if (geo.attributes.normal !== undefined) {
        const new_normal_arr = new Float32Array(new_vert_count * 3);
        const og_normal_arr = geo.attributes.normal.array;
        for (let i = 0; i < unique_indices.length; ++i) {
            const old_idx = unique_indices[i];
            const new_idx = i;
            new_normal_arr[new_idx*3] = og_normal_arr[old_idx*3];
            new_normal_arr[new_idx*3 + 1] = og_normal_arr[old_idx*3 + 1];
            new_normal_arr[new_idx*3 + 2] = og_normal_arr[old_idx*3 + 2];
        }

        const new_normal_attr = new THREE.BufferAttribute(new_normal_arr, 3);
        new_geo.setAttribute('normal', new_normal_attr);
    }

    if (geo.attributes.uv !== undefined) {
        const new_uv_arr = new Float32Array(new_vert_count * 2);
        const og_uv_arr = geo.attributes.normal.array;
        for (let i = 0; i < unique_indices.length; ++i) {
            const old_idx = unique_indices[i];
            const new_idx = i;
            new_uv_arr[new_idx*2] = og_uv_arr[old_idx*2];
            new_uv_arr[new_idx*2 + 1] = og_uv_arr[old_idx*2 + 1];
        }

        const new_uv_attr = new THREE.BufferAttribute(new_uv_arr, 2);
        new_geo.setAttribute('uv', new_uv_attr);
    }

    const new_indices = new Uint16Array(indices);
    // update old indices to point to our new arrangement of indices 
    for (let i = 0; i < new_indices.length; ++i) {
        new_indices[i] = indices_map.get(new_indices[i]);
    }
    // create new index buffer
    new_geo.setIndex(new THREE.BufferAttribute(new_indices, 1));

    // update bounds for geometry (three.js does not auto calculate)
    new_geo.computeBoundingBox();
    new_geo.computeBoundingSphere();

    return new_geo;
}

function split_node_geo(node)
{
    if (node.selected_indices === undefined || node.selected_indices.length < 3) {
        console.warn('Node must have vertices selected in order to split');
        return;
    }

    const geo = node.geometry;

    const new_tris = [];
    const old_tris = [];
    // NOTE: create a set here for faster lookups instead of using array.includes()
    const indices_set = new Set(node.selected_indices);
    // indexed triangles
    if (geo.index !== undefined) {

        const array = geo.index.array;

        // categorize triangles based on whether their vertices are selected or not
        for (let i = 0; (i+2) < array.length; i+=3) {
            const a_idx = array[i];
            const b_idx = array[i+1];
            const c_idx = array[i+2];

            if (indices_set.has(a_idx)
                && indices_set.has(b_idx)
                && indices_set.has(c_idx)) {
                new_tris.push(a_idx, b_idx, c_idx);
            } else {
                old_tris.push(a_idx, b_idx, c_idx);
            }
        }

        // create new geometries based off our new indices
        const geo_split_new = node_create_new_geometry_with_indices(geo, new_tris);
        const geo_split_old = node_create_new_geometry_with_indices(geo, old_tris);

        // free original geometry
        geo.dispose();

        node.geometry = geo_split_old;
        node_destroy_verts_drawing(node);
        node.selected_indices = undefined;

        const new_node = node.clone();
        new_node.geometry = geo_split_new;
        new_node.material = node.og_mat;

        node.parent.add(new_node);


    } else {
        // non-indexed triangles
        // TODO: need a test case here...
    }


}

function add_on_click(el, f)
{
    el.addEventListener('click', f);
}

function toggle_selected(el, cond)
{
    if(cond) {
        el.classList.add('selected');
    } else {
        el.classList.remove('selected');
    }
}

function toggle_visible(el, cond)
{
    if (cond) {
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
    }
}

function toggle_enabled(el, cond)
{
    if (cond) {
        el.classList.remove('disabled');
        for (let i = 0; i < el.children.length; ++i) {
            const child = el.children[i];
            child.disabled = false;
        }
    } else {
        el.classList.add('disabled');
        for (let i = 0; i < el.children.length; ++i) {
            const child = el.children[i];
            child.disabled = true;
        }
    }
}


class Ui {
    constructor() {
        const els = document.querySelectorAll('#controls button[id], #controls div[id], #controls input[id]');
        for (let i = 0; i < els.length; ++i) {
            const el = els[i];
            this[el.id] = el;
        }

        add_on_click(this.btn_load, () => {
            load_model();
            this.btn_load.remove();
        });
        add_on_click(this.btn_select, () => {
            editor.setup_select_mode();
            this.update();
        });
        add_on_click(this.btn_lasso, () => {
            editor.setup_lasso_mode();
            this.update();
        });

        add_on_click(this.btn_vertex, () => {
            editor.setup_vertex_mode();
            this.update();
        });
        add_on_click(this.btn_object, () => {
            editor.switch_to_object_mode();
            this.update();
            on_render();
        });

        add_on_click(this.btn_snap_mode_face, () => {
            editor.snap_mode = eSnapMode.FACE;
            this.update();
        });
        add_on_click(this.btn_snap_mode_vertex, () => {
            editor.snap_mode = eSnapMode.VERTEX;
            this.update();
        });

        add_on_click(this.btn_clear, () => {
            editor.clear_selected();
            this.update();
            on_render();
        });

        this.chk_snap_align_rotation.addEventListener('change', () => {
            editor.should_snap_align_rotation = this.chk_snap_align_rotation.checked;
        });

        add_on_click(this.btn_snap_to, () => {
            editor.begin_snap();
            this.update();
            on_render();
        });

        add_on_click(this.btn_split, () => {
            editor.split_selected_node();
            editor.clear_selected();
            on_render();
        });

        add_on_click(this.btn_join, () => {
            editor.join_selected_nodes();
            on_render();
        });

        add_on_click(this.btn_merge_vertex, () => {
            editor.begin_merge_vertex_mode();
            this.update();
            on_render();
        });

        this.lbl_instruct = document.getElementById('lbl_instruct');

        this.update();
    }

    update() {
        toggle_selected(this.btn_select,
            editor.state === eState.SELECT 
            && editor.select_mode === eSelectMode.SELECT);
        toggle_selected(this.btn_lasso,
            editor.state === eState.SELECT
            && editor.select_mode === eSelectMode.LASSO);

        toggle_selected(this.btn_object, 
            editor.edit_mode == eEditMode.OBJECT);
        toggle_selected(this.btn_vertex,
            editor.edit_mode == eEditMode.VERTEX);

        toggle_selected(this.btn_snap_to,
            editor.state === eState.SNAP);

        toggle_selected(this.btn_snap_mode_face,
            editor.snap_mode == eSnapMode.FACE);

        toggle_selected(this.btn_snap_mode_vertex,
            editor.snap_mode == eSnapMode.VERTEX);

        this.lbl_selected_nodes.innerText = 'Selected Nodes: ' + editor.selected_nodes.length;
        this.lbl_selected_verts.innerText = 'Selected Verts: ' + editor.count_selected_verts();

        toggle_visible(this.btn_clear, 
            editor.selected_nodes.length > 0);

        toggle_visible(this.panel_snap,
            editor.selected_nodes.length === 1);

        this.chk_snap_align_rotation.checked = editor.should_snap_align_rotation;

        toggle_visible(this.btn_split,
            editor.selected_nodes.length > 0
            && editor.count_selected_verts() > 0);

        toggle_visible(this.btn_join,
            editor.selected_nodes.length === 2);

        toggle_visible(this.btn_merge_vertex,
            editor.selected_nodes.length === 1);

        toggle_visible(this.lbl_instruct,
            editor.state === eState.JOIN_SELECT_VERTEX1
            || editor.state === eState.JOIN_SELECT_VERTEX2);

        if (editor.state === eState.JOIN_SELECT_VERTEX1) {
            this.lbl_instruct.innerText = 'Select First Vertex';
        } else if (editor.state === eState.JOIN_SELECT_VERTEX2) {
            this.lbl_instruct.innerText = 'Select Second Vertex';
        }

    }
};

function load_model() 
{
    const loading_panel = document.getElementById('panel_loading');
    const loading_fill = document.getElementById('loading-bar-fill');
    const loading_text = document.getElementById('loading-text');
    loading_panel.style.display = 'block';

    gltf_loader.load(
        //'./synode_202_assets_others_3d_General_Final_119.glb',
        './Ex3_snapping.glb',
        (gltf) => {
            loading_panel.style.display = 'none';

            editor.scene = gltf.scene;
            g.scene.add(editor.scene);
            editor.obj_count = 0;

            if (debug) {
                // display bounding boxes for objects
                for (const obj of gltf.scene.children) {
                    obj.bbox_draw = new THREE.BoxHelper(obj, 0xFF0000);
                    g.scene.add(obj.bbox_draw);
                }
            }

            on_render();
        },
        (xhr) => {
            const pct = Math.round((xhr.loaded / xhr.total) * 100);
            loading_fill.style.width = pct + '%';
            loading_text.textContent = 'Loading gltf model... Bytes Loaded:' +xhr.loaded;// pct + '%';
        }
    );
}

class Input {
    constructor() {
        this.mouse = new THREE.Vector2();
        this.is_pointer_down = false;
        // flags if orbit controls were used during pointer events, to skip our logic
        this.used_cam_controls = false;

    }
};



function app_on_pointerdown(ev) {
    input.used_cam_controls = false;
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
        // ignore clicks other than left
        return;
    }

    input.is_pointer_down = true;
    input.mouse.x = ev.clientX;
    input.mouse.y = ev.clientY;

    editor.on_pointerdown();

    on_render();
}

function app_on_pointerup(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
        // ignore clicks other than left
        return;
    }

    if (g.tform_gizmo.visible && g.tform_gizmo.dragging) {
        return;
    }

    // skip executing our events if camera was used (not a click)
    if (input.used_cam_controls) {
        input.used_cam_controls = false;
        return;
    }

    // We had a full click without using transform gizmo and without dragging camera
    editor.on_pointerup();

    on_render();
}

function app_on_pointermove(ev) {
    input.mouse.x = ev.clientX;
    input.mouse.y = ev.clientY;

    const mouse_ndc = vec2_vp_to_ndc(input.mouse);
    raycaster.setFromCamera(mouse_ndc, g.cam);

    editor.on_pointermove();

    ui.update();
    if (should_update_render) {
        should_update_render = false;
        on_render();
    }
}

function gpu_get_res()
{
    gpu.getSize(gpu.res);
    return gpu.res;
}

function update_gpu_backbuffer() 
{
  const new_width = gpu.domElement.clientWidth;
  const new_height = gpu.domElement.clientHeight;
  const should_resize = gpu.domElement.width !== new_width 
        || gpu.domElement.height !== new_height;
  if (should_resize) {
      gpu.setSize(new_width, new_height, false);
  }
}

function update_cameras()
{
    const res = gpu_get_res();
    g.cam.aspect = res.x / res.y;
    g.cam.updateProjectionMatrix();

    //centered ortho
    /*cam_ui.left = -res.x * 0.5;
    cam_ui.right = res.x * 0.5;
    cam_ui.top = res.y * 0.5;
    cam_ui.bottom = -res.y * 0.5;*/
    // top left aligned ortho
    cam_ui.left = 0;
    cam_ui.right = res.x;
    cam_ui.top = 0;
    cam_ui.bottom = res.y;
    cam_ui.near = 0.1;
    cam_ui.far = 10;
    cam_ui.updateProjectionMatrix();
}

function setup_lui()
{
    const panel_debug_info = gui.addFolder('Debug Info');
    panel_debug_info.add(input.mouse, 'x').listen().name('Mouse X').disable();
    panel_debug_info.add(input.mouse, 'y').listen().name('Mouse Y').disable();

    const panel_debug_lasso = panel_debug_info.addFolder('Lasso');
    panel_debug_lasso.add(lasso, 'point_count').listen().disable();

    const panel_render_info = panel_debug_info.addFolder('Render');
    panel_render_info.add(editor, 'obj_count').listen().disable();
    panel_render_info.add(gpu.info.memory, 'geometries').name('Geometry Count').listen().disable();
    panel_render_info.add(gpu.info.programs, 'length').name('Program Count').listen().disable();
    panel_render_info.add(gpu.info.render, 'calls').name('Draw Calls').listen().disable();
    panel_render_info.add(gpu.info.render, 'frame').name('Frame').listen().disable();
    panel_render_info.add(gpu.info.render, 'lines').name('Line Count').listen().disable();
    panel_render_info.add(gpu.info.render, 'points').name('Point Count').listen().disable();
    panel_render_info.add(gpu.info.render, 'triangles').name('Triangle Count').listen().disable();

}


// worldspace to viewport
function ws_to_vp(cam, pt_ws)
{
    const res = gpu_get_res();
    const pt_vp = pt_ws.clone();
    // convert to ndc
    pt_vp.project(cam);
    // convert to vp
    pt_vp.x = (pt_vp.x + 1) / 2 * res.x;
    pt_vp.y = (pt_vp.y - 1) / -2 * res.y;
    return pt_vp;

}

function vec2_vp_to_ndc(pt_vp)
{
    const res = gpu_get_res();
    const pt_ndc = new THREE.Vector2();
    pt_ndc.x = (pt_vp.x / res.x) * 2 - 1;
    pt_ndc.y = - (pt_vp.y / res.y) * 2 + 1;
    return pt_ndc;
}

//viewport to worldspace
function vp_to_ws(pt_vp)
{
    const res = gpu_get_res();
    // convert to ndc first
    const pt_ws = new THREE.Vector3(
        -1 + (pt_vp.x / res.x) * 2,
        1 + (pt_vp.y / res.y) * -2,
        0);
    // ndc to ws
    pt_ws.unproject(g.cam);
    return pt_ws;
}

function vec4_xy(v4)
{
    return new THREE.Vector2(v4.x, v4.y);
}

function vec3_to_vec2(v3)
{
    return new THREE.Vector2(v3.x, v3.y);
}

function box3_get_corners(box3)
{
    const min = box3.min;
    const max = box3.max;
    return [
        new THREE.Vector3(min.x, min.y, min.z),
        new THREE.Vector3(min.x, min.y, max.z),
        new THREE.Vector3(min.x, max.y, min.z),
        new THREE.Vector3(min.x, max.y, max.z),
        new THREE.Vector3(max.x, min.y, min.z),
        new THREE.Vector3(max.x, min.y, max.z),
        new THREE.Vector3(max.x, max.y, min.z),
        new THREE.Vector3(max.x, max.y, max.z),
    ];

}

function node_get_box2_in_viewport(node)
{
    const box3_ws = new THREE.Box3().setFromObject(node);
    const corners_ws = box3_get_corners(box3_ws);
    //convert to vp
    const corners_vp = new Array(8);
    for (let ci = 0; ci < corners_ws.length; ++ci) {
        corners_vp[ci] = ws_to_vp(g.cam, corners_ws[ci]);
    }
    const node_box2_vp = new THREE.Box2();
    node_box2_vp.setFromPoints(corners_vp);

    return node_box2_vp;
}

function get_viewport_box2()
{
    const box = new THREE.Box2();
    box.min.x = 0;
    box.min.y = 0;
    box.max.x = gpu.res.x;
    box.max.y = gpu.res.y;
    return box;
}

// loops through geometry positions and check if they lie within lasso
// returns indices of positions that fall within lasso
// if quick_check is true, returns first index only.
function lasso_vs_node(node, quick_check) 
{
    const indices = [];
    if (node.geometry !== undefined) {
        const pos_attr = node.geometry.getAttribute('position');

        let pos = new THREE.Vector4();
        let model_to_clip = new THREE.Matrix4();
        //model to view space
        model_to_clip.multiplyMatrices(g.cam.matrixWorldInverse, node.matrixWorld);
        // view space to clip space
        model_to_clip.multiplyMatrices(g.cam.projectionMatrix, model_to_clip);

        const res = gpu_get_res();

        for (let vi = 0; vi < pos_attr.count; ++vi) {
            pos.x = pos_attr.getX(vi);
            pos.y = pos_attr.getY(vi);
            pos.z = pos_attr.getZ(vi);
            pos.w = 1;
            pos.applyMatrix4(model_to_clip);

            // check if point is within near/far planes
            if (pos.z >= -pos.w && pos.z <= pos.w) {
                // perspective divide
                pos.x /= pos.w;
                pos.y /= pos.w;
                pos.z /= pos.w;;
                // convert to vp
                pos.x = (pos.x + 1) / 2 * res.x;
                pos.y = (pos.y - 1) / -2 * res.y;
                if (lasso.contains_point(vec4_xy(pos))) {
                    if (quick_check) {
                        return [vi];
                    }
                    indices.push(vi);
                }
            }
        }
    }
    return indices;

}

//NOTE: this gets recursively called for all child nodes
function lasso_vs_nodes(nodes)
{
    const screen_box = get_viewport_box2();

    for (let ni = 0; ni < nodes.length; ++ni) {
        const node = nodes[ni];

        const node_box = node_get_box2_in_viewport(node);

        if (!node_box.intersectsBox(lasso.bbox2_vp)) {
            // skip doing lasso tests for this obj and all its children if our bbox test fails
            if (debug && screen_box.intersectsBox(node_box)) {
                dlines.add_box2(node_box, new THREE.Color().setHex(0xFF0000));
            }
            continue;
        }
        if (debug) {
            dlines.add_box2(node_box, new THREE.Color().setHex(0x00FF00));
        }

        if (lasso_vs_node(node, true).length) {
            editor.select_node(node);
        }


        if (node.children !== undefined) {
            lasso_vs_nodes(node.children);
        }
    }

}

const MAX_DEBUG_VERTS = 1024;

class DebugLines {
    constructor() {
        this.verts_pos = new Float32Array(MAX_DEBUG_VERTS * 3);
        this.verts_color = new Float32Array(MAX_DEBUG_VERTS * 3);
        const mat = new THREE.LineBasicMaterial({
            color:0xFFFFFF,
            vertexColors: true});
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.verts_pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(this.verts_color, 3, false));
        this.node_line = new THREE.LineSegments(geo, mat);

        this.verts_count = 0;
    }

    //Vec3 a, b
    //Color color
    add_line(a, b, color) {
        if (this.verts_count+2 > MAX_DEBUG_VERTS) {
            return;
        }
        const geo = this.node_line.geometry;
        const pos_attr = geo.attributes.position;
        pos_attr.setXYZ(this.verts_count, a.x, a.y, a.z);
        pos_attr.setXYZ(this.verts_count + 1, b.x, b.y, b.z);

        const color_attr = geo.attributes.color;
        color_attr.setXYZ(this.verts_count, color.r, color.g, color.b);
        color_attr.setXYZ(this.verts_count+1, color.r, color.g, color.b);

        this.verts_count += 2;
        geo.setDrawRange(0, this.verts_count);
        pos_attr.needsUpdate = true;
        color_attr.needsUpdate = true;
    }

    clear() {
        const geo = this.node_line.geometry;
        geo.setDrawRange(0, 0);
        this.verts_count = 0;
    }

    add_box2(box2, color) {
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();

        vec3_set_xy_v2(a, box2.min);
        vec3_set_xy(b, box2.min.x, box2.max.y);
        this.add_line(a, b, color);

        vec3_set_xy_v2(a, box2.max);
        this.add_line(a, b, color);

        vec3_set_xy(b, box2.max.x, box2.min.y);
        this.add_line(a, b, color);

        vec3_set_xy_v2(a, box2.min);
        this.add_line(a, b, color);
    }
}

function vec3_set_xy_v2(v3, v2)
{
    v3.x = v2.x;
    v3.y = v2.y;
}

function vec3_set_xy(v3, x, y)
{
    v3.x = x;
    v3.y = y;
}

const MAX_LASSO_VERTS = 256;

class Lasso {
    constructor() {
        this.verts_pos = new Float32Array(MAX_LASSO_VERTS * 3);
            //mat: new THREE.LineBasicMaterial({color:0xff0000}),
        this.mat = new THREE.LineDashedMaterial({color:0xff0000,
                dashSize:5,
                gapSize:5});
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.verts_pos, 3));
        this.node_line = new THREE.Line(geo, this.mat);

        this.bbox2_vp = new THREE.Box2();

        this.point_count = 0;
        this.is_drawing = false;
    }

    get_point_at_index(index) {
        if (index < 0 || index > this.point_count) {
            return new THREE.Vector2(0,0);
        }

        const pos_attr = this.node_line.geometry.attributes.position;
        return new THREE.Vector2(
            pos_attr.getX(index),
            pos_attr.getY(index));
    }

    get_last_point() {
        return this.get_point_at_index(this.point_count - 1);
    }

    add_point() {

        //TODO OPT: If the new point lies in the same direction as the last edge, replace the last edge point with the new point to extend the edge
        //
        // leave room for 1 vert at end which will be a duplicate of our first vert to seal the lasso
        if (this.point_count < (MAX_LASSO_VERTS-1)) {
            const prev_point = this.get_last_point();
            const NEW_POINT_DIST_THRESHOLD_SQ = 12 * 12;
            if (this.point_count == 0 
                || prev_point.distanceToSquared(input.mouse) >= NEW_POINT_DIST_THRESHOLD_SQ) {
                const pos_attr = this.node_line.geometry.attributes.position;
                pos_attr.setXYZ(this.point_count, 
                    input.mouse.x, input.mouse.y, 0);
                ++this.point_count;
                const first_point = this.get_point_at_index(0);
                pos_attr.setXYZ(this.point_count, 
                    first_point.x, first_point.y, 0);

                this.bbox2_vp.expandByPoint(input.mouse);

                //NOTE: only needed if we are using dashed material
                this.node_line.computeLineDistances();
                this.node_line.geometry.attributes.position.needsUpdate = true;
                // + 1 to draw extra edge to enclose lasso
                this.node_line.geometry.setDrawRange(0, this.point_count + 1);

                return true;
            }
        }
        return false;

    }

    clear() {
        this.point_count = 0;
        this.node_line.geometry.setDrawRange(0, 0);
        this.bbox2_vp.makeEmpty();
    }

    begin_new_selection() {
        this.clear();
        this.is_drawing = true;
    }

    end_selection() {
        this.clear();
        this.is_drawing = false;
    }

    // Vec2 test_pt
    contains_point(test_pt) {
        // Using winding number algo here:
        // Count how many edges cross the horizontal split plane passing through test_pt to determine if test_pt is contained or not
        // Increment/decrement the count depending on the direction of the cross
        let cross_count = 0;

        for (let i = 0; i < this.point_count; ++i) {
            // get next points going around lasso that form edge (a <-> b)
            const a = this.get_point_at_index(i);
            const b = this.get_point_at_index((i + 1) % this.point_count);

            // get distance of edge points from horizontal split plane
            const a_signed_dist_horz = a.y - test_pt.y;
            const b_signed_dist_horz = b.y - test_pt.y;

            const crosses = (a_signed_dist_horz * b_signed_dist_horz) < 0;
            if (!crosses) {
                continue;
            }

            const dir_downwards = (a_signed_dist_horz < b_signed_dist_horz);

            // get vectors going from test point to edge points to do an orientation test
            const test_to_a = a.sub(test_pt);
            const test_to_b = b.sub(test_pt);

            // NOTE: we get orientation of triangle (using cross product) to only count edges to the right of test_pt
            // sign of cross product value changes based on direction
            //
            if (dir_downwards) {
                if (vec2_cross(test_to_a, test_to_b) < 0) {
                    ++cross_count;
                }
            } else {
                if (vec2_cross(test_to_a, test_to_b) > 0) {
                    --cross_count;
                }
            }
        }

        return cross_count !== 0;
    }


};

function vec2_cross(a, b)
{
    return (a.x * b.y) - (a.y * b.x);
}

function on_win_resize()
{
    on_render();
}

function on_render(time_ms)
{

    update_gpu_backbuffer();
    update_cameras();

    let time_sec = time_ms * 0.001;

    gpu.info.autoReset = false; 
    gpu.info.reset();

    gpu.setClearColor(0x393939);
    gpu.clear();

    gpu.render(g.scene, g.cam);
    gpu.clearDepth();
    gpu.render(scene_ui, cam_ui);

    ui.update();
}



const input = new Input();
let editor = new Editor();

const ui = new Ui();
const gui = new lil.GUI();

const gltf_loader = new GLTFLoader();

const g = {
    scene:undefined,
    cam_controls: undefined,
    tform_gizmo:undefined,
    cam: undefined,
};


function setup_empty_scene()
{
    g.scene = new THREE.Scene();

    // init camera
    {
        const fov_deg = 40;
        const aspect = 1;
        const near_dist = 0.1;
        const far_dist = 500;
        g.cam = new THREE.PerspectiveCamera(fov_deg, aspect, near_dist, far_dist);
        g.cam.position.z = 10;
    }

    g.cam_controls = new OrbitControls(g.cam, gpu.domElement);
    //cam_controls.listenToKeyEvents(window);
    //NOTE: if manual changes are made to the camera we must call this afterwards:
    //cam_controls.update();
    //
    //
    g.cam_controls.addEventListener( 'change', () => {
        input.used_cam_controls = true;
        on_render();
    });

    g.tform_gizmo = new TransformControls(g.cam, gpu.domElement);
    g.tform_gizmo.addEventListener('change', on_render);

    // disable camera controls when using gizmo
    g.tform_gizmo.addEventListener( 'dragging-changed', (event) => {
        g.cam_controls.enabled = ! event.value;
    });

    g.scene.add(g.tform_gizmo);

    //setup some default env lighting
    {
        const environment = new RoomEnvironment(gpu);
        const pmremGenerator = new THREE.PMREMGenerator(gpu);

        g.scene.background = new THREE.Color( 0xbbbbbb );
        g.scene.environment = pmremGenerator.fromScene(environment).texture;
    }

    // grid setup
    {
        const grid_size = 20;
        const grid_divisions = grid_size * 2;
        const grid_center_line_color = 0xFF9050;
        const grid_color = 0x494949;
        const grid = new THREE.GridHelper(grid_size, grid_divisions, grid_center_line_color, grid_color);
        g.scene.add(grid);
    }
}

const scene_ui = new THREE.Scene();
const raycaster = new THREE.Raycaster();

const dlines = new DebugLines();
if (debug) {
    scene_ui.add(dlines.node_line);
}

const lasso = new Lasso();
scene_ui.add(lasso.node_line);

let canvas = undefined;
let gpu = undefined;

let cam_ui = undefined;

function init()
{
    canvas = document.querySelector('#c');
    canvas.addEventListener('pointerdown', app_on_pointerdown, false);
    canvas.addEventListener('pointerup', app_on_pointerup, false);
    canvas.addEventListener('pointermove', app_on_pointermove, false);

    window.addEventListener('resize', on_win_resize);

    gpu = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
        canvas: canvas});
    gpu.setPixelRatio(window.devicePixelRatio);
    gpu.autoClear = false;
    gpu.res = new THREE.Vector2();


    {
        const res = gpu_get_res();
        const left = -res.x * 0.5;
        const right = res.x * 0.5;
        const top = res.y * 0.5;
        const bottom = -res.y * 0.5;
        const near = 0.1;
        const far = 10;
        cam_ui = new THREE.OrthographicCamera(
            left, right,
            top, bottom,
            near, far);
        cam_ui.position.z = 1;
    }


    setup_empty_scene();
    setup_lui();
    on_render();
}

init();

