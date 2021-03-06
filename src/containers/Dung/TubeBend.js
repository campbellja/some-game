import React, { Component } from 'react';
import THREE from 'three';

const tubeRadius = 0.5;
const bendSpline = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3( 0, 0, 0 ),
    new THREE.Vector3( 0, tubeRadius, 0 ),
    new THREE.Vector3( tubeRadius, tubeRadius )
);

const extrudeSettings = {
    curveSegments: 5,
    amount: 1,
    bevelEnabled: false,
    bevelSegments: 0,
    steps: 10,
    bevelSize: 0,
    closed: false,
    extrudePath: bendSpline,
    bevelThickness: 0
};

const offset = new THREE.Vector3( 0, -0.5, 0 );
const rotationOffset = new THREE.Euler( 0, Math.PI / 2, 0 );

export default class TubeBend extends Component {

    constructor(props, context) {

        super(props, context);

    }

    render() {

        const { position, rotation, scale, materialId } = this.props;

        return <group
            position={ position }
            rotation={ new THREE.Euler().setFromQuaternion( rotation ) }
            scale={ scale }
        >

            <mesh
                position={ offset }
                rotation={ rotationOffset }
                ref="mesh"
            >
                <extrudeGeometry
                    settings={ extrudeSettings }
                >
                    <shapeResource
                        resourceId="tubeWall"
                    />
                </extrudeGeometry>
                <materialResource
                    resourceId={ materialId }
                />
            </mesh>

        </group>;

    }

}
