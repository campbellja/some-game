import 'babel/polyfill';
import React, { Component } from 'react';
import React3 from 'react-three-renderer';
import THREE from 'three';
import CANNON from 'cannon/src/Cannon';
import StaticEntities from '../Dung/StaticEntities';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import { scalePlayer, advanceLevel } from '../../redux/modules/game';
import KeyCodes from '../Dung/KeyCodes';
import Cardinality from '../Dung/Cardinality';
import TubeBend from '../Dung/TubeBend';
import TubeStraight from '../Dung/TubeStraight';
import Player from '../Dung/Player';
import { getEntrancesForTube, without } from '../Dung/Utils';

// see http://stackoverflow.com/questions/24087757/three-js-and-loading-a-cross-domain-image
THREE.ImageUtils.crossOrigin = '';
THREE.TextureLoader.crossOrigin = '';

THREE.TextureLoader.prototype.crossOrigin = '';

const radius = 20;
const lightRotationSpeed = 0.5;
const clock = new THREE.Clock();

const gameWidth = 400;
const gameHeight = 400;
const cameraAspect = gameWidth / gameHeight;
const cameraFov = 75;

const shadowD = 20;
const boxes = 5;

const tubeTravelDurationMs = 200;
const tubeStartTravelDurationMs = 50;

const wallJumpVerticalDampen = 0.4;

const coolDownTimeMs = 500;

const raycaster = new THREE.Raycaster();

const cameraMultiplierFromPlayer = 3;

const vec3Equals = ( a, b ) => a.clone().sub( b ).length() < 0.0001;

const lerp = ( () => {
    const v = new THREE.Vector3();
    return v.lerpVectors.bind( v );
} )();

const cameraAngleScale = 0.9;

const wallMaterial = new CANNON.Material( 'wallMaterial' );

// Adjust constraint equation parameters for ground/ground contact
const material = new CANNON.ContactMaterial( wallMaterial, wallMaterial, {
    friction: 1,
    // Bounciness (0-1, higher is bouncier). How much energy is conserved
    // after a collision
    restitution: 0.4,
    contactEquationStiffness: 1e8,
    contactEquationRelaxation: 3,
    frictionEquationStiffness: 1e9,
    frictionEquationRegularizationTime: 3,
});

function getCameraDistanceToPlayer( aspect, fov, objectSize ) {

    return Math.abs( objectSize / Math.sin( ( fov * ( Math.PI / 180 ) ) / 2 ) );

}

function getCardinalityOfVector( v3 ) {

    const { field, value } = [
        { field: 'x', value: v3.x },
        { field: 'y', value: v3.y },
        { field: 'z', value: v3.z }
    ].sort( ( a, b ) => {
        return Math.abs( a.value ) - Math.abs( b.value );
    })[ 2 ];

    if( field === 'x' ) {
        return value < 0 ? Cardinality.LEFT : Cardinality.RIGHT;
    } else if( field === 'y' ) {
        return value < 0 ? Cardinality.BACK : Cardinality.FORWARD;
    } else {
        return value < 0 ? Cardinality.UP : Cardinality.DOWN;
    }

}

function snapVectorAngleTo( v3, snapAngle ) {

    const angle = v3.angleTo( Cardinality.UP );

    if( angle < snapAngle / 2.0 ) {
        return Cardinality.UP.clone().multiplyScalar( v3.length() );
    } else if( angle > 180.0 - snapAngle / 2.0 ) {
        return Cardinality.DOWN.clone().multiplyScalar( v3.length() );
    }

    const t = Math.round( angle / snapAngle );
    const deltaAngle = ( t * snapAngle ) - angle;

    const axis = new THREE.Vector3().crossVectors( Cardinality.UP, v3 );
    const q = new THREE.Quaternion().setFromAxisAngle( axis, deltaAngle );

    return v3.clone().applyQuaternion( q );

}

function resetBodyPhysics( body, position ) {

    // Position
    body.position.copy( position );
    body.previousPosition.copy( position );
    body.interpolatedPosition.copy( position );
    body.initPosition.copy( position );

    // orientation
    body.quaternion.set( 0, 0, 0, 1 );
    body.initQuaternion.set( 0, 0, 0, 1 );
    body.previousQuaternion.set( 0, 0, 0, 1 );
    body.interpolatedQuaternion.set( 0, 0, 0, 1 );

    // Velocity
    body.velocity.setZero();
    body.initVelocity.setZero();
    body.angularVelocity.setZero();
    body.initAngularVelocity.setZero();

    // Force
    body.force.setZero();
    body.torque.setZero();

    // Sleep state reset
    body.sleepState = 0;
    body.timeLastSleepy = 0;
    body._wakeUpAfterNarrowphase = false;
}

function lookAtVector( sourcePoint, destPoint ) {
    
    return new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt( sourcePoint, destPoint, Cardinality.UP )
    );

}

function findNextTube( tube, entrance, entities, scale ) {

    const { entrance1, entrance2 } = getEntrancesForTube( tube, scale );

    const isEntrance1 = vec3Equals( entrance, entrance1 );
    const isEntrance2 = vec3Equals( entrance, entrance2 );

    if( !isEntrance1 && !isEntrance2 ) {
        console.warn( 'Entrance',entrance,'did not match',entrance1,'or',entrance2 );
        return null;
    }

    const exit = isEntrance1 ? entrance2 : entrance1;

    const nextTube = entities.find( ( entity ) => {
        return vec3Equals( entity.position, exit );
    });

    if( nextTube ) {

        return getEntrancesForTube( nextTube, scale );

    }

}

function snapTo( number, interval ) {

    return interval * Math.ceil( number / interval );

}

@connect(
    ( state ) => {

        const { levels } = state.game;
        const currentLevel = levels[ state.currentLevel ];
        const allEntities = state.game.entities;

        // Potential placeholder for showing multiple levels at the same time?
        const visibleEntities = currentLevel.entityIds.map( id => allEntities[ id ] );

        const nextLevel = currentLevel.nextLevelId && {
            level: levels[ currentLevel.nextLevelId ],
            ...Object.keys( allEntities )
                .map( id => allEntities[ id ] )
                .find( entity => entity.type === 'level' )
        };

        const nextLevelEntities = nextLevel && nextLevel.level.entityIds
            .map( id => allEntities[ id ] )
            .filter( entity => entity.type !== 'level' );

        return {
            currentLevel,
            levels,
            visibleEntities,
            allEntities,
            nextLevel,
            nextLevelEntities,
            jumpForce: state.game.jumpForce,
            moveForce: state.game.moveForce,
            airMoveForce: state.airMoveForce,
            playerPosition: state.game.playerPosition,
            playerRadius: state.game.playerRadius,
            playerScale: state.game.playerScale,
            playerMass: state.game.playerMass,
        };

    },
    dispatch => bindActionCreators( { scalePlayer, advanceLevel }, dispatch )
)
export default class Game extends Component {

    constructor( props, context ) {

        super( props, context );

        this.keysDown = {};

        this.state = {
            playerContact: {},
            cameraPosition: new THREE.Vector3(
                0,
                cameraMultiplierFromPlayer * getCameraDistanceToPlayer( cameraAspect, cameraFov, 1 ),
                0
            ),
            lightPosition: new THREE.Vector3(),
            meshStates: []
        };

        this.wallCoolDowns = {};

        this.world = new CANNON.World();
        const world = this.world;

        // Add contact material to the world
        world.addContactMaterial( material );

        world.quatNormalizeSkip = 0;
        world.quatNormalizeFast = false;

        world.gravity.set( 0, -9.8, 9.8 );
        world.broadphase = new CANNON.NaiveBroadphase();

        this.onKeyDown = this.onKeyDown.bind( this );
        this.onKeyUp = this.onKeyUp.bind( this );
        this.updatePhysics = this.updatePhysics.bind( this );
        this._onAnimate = this._onAnimate.bind( this );
        this._getMeshStates = this._getMeshStates.bind( this );
        this.onPlayerCollide = this.onPlayerCollide.bind( this );
        this.onPlayerContactEndTest = this.onPlayerContactEndTest.bind( this );
        this._setupPhysics = this._setupPhysics.bind( this );

        // Needs proper scoping of this before we can call it :(
        this._setupPhysics( props );

    }

    _setupPhysics( props, playerPosition ) {

        const { currentLevel, allEntities, playerRadius, playerMass } = props;
        const { entityIds } = currentLevel;

        const playerBody = new CANNON.Body({
            material: wallMaterial,
            mass: playerMass
        });
        this.playerBody = playerBody;

        const playerShape = new CANNON.Sphere( playerRadius );

        playerBody.addShape( playerShape );
        playerBody.position.copy( playerPosition || props.playerPosition );
        this.world.addBody( playerBody );

        const physicsBodies = [ playerBody ].concat( entityIds.reduce( ( ents, id ) => {

            const entity = allEntities[ id ];

            if( entity.type === 'shrink' || entity.type === 'grow' ) {
                return ents;
            }

            const { position, scale } = entity;
            const entityBody = new CANNON.Body({
                mass: 0,
                material: wallMaterial
            });
            const boxShape = new CANNON.Box( new CANNON.Vec3(
                scale.x / 2,
                scale.y / 2,
                scale.z / 2
            ));
            entityBody.addShape( boxShape );
            entityBody.position.set(
                position.x,
                position.y,
                position.z
            );
            entityBody.entity = entity;
            this.world.addBody( entityBody );
            return ents.concat( entityBody );

        }, [] ));

        this.physicsBodies = physicsBodies;

        this.playerBody.addEventListener( 'collide', this.onPlayerCollide );
        this.world.addEventListener( 'endContact', this.onPlayerContactEndTest );

    }

    componentDidMount() {

        window.addEventListener( 'keydown', this.onKeyDown );
        window.addEventListener( 'keyup', this.onKeyUp );

    }

    componentWillUnmount() {

        window.removeEventListener( 'keydown', this.onKeyDown );
        window.removeEventListener( 'keyup', this.onKeyUp );

        this.playerBody.removeEventListener( 'collide', this.onPlayerCollide );
        this.world.removeEventListener( 'endContact', this.onPlayerContactEndTest );

    }

    componentWillReceiveProps( nextProps ) {

        if( nextProps.currentLevel.id !== this.props.currentLevel.id ) {

            const { nextLevel } = this.props;
            const { cameraPosition } = this.state;

            this.setState({ cameraPosition: new THREE.Vector3(
                ( cameraPosition.x - nextLevel.position.x ) * 2 * 2 * 2,
                1.5 + cameraMultiplierFromPlayer * getCameraDistanceToPlayer( cameraAspect, cameraFov, 1 ),
                ( cameraPosition.z - nextLevel.position.z ) * 2 * 2 * 2
            ) });

        }

    }

    componentWillUpdate( nextProps, nextState ) {

        if( nextProps.currentLevel.id !== this.props.currentLevel.id ) {

            this.world.removeEventListener( 'endContact', this.onPlayerContactEndTest );
            this.playerBody.removeEventListener( 'collide', this.onPlayerCollide );

            this.physicsBodies.map( body => this.world.remove( this.playerBody ) );

            const { nextLevel } = this.props;
            const { position } = this.playerBody;
            const newPosition = new CANNON.Vec3(
                ( position.x - nextLevel.position.x ) * 2 * 2 * 2,
                1.5,
                ( position.z - nextLevel.position.z ) * 2 * 2 * 2,
            );

            this._setupPhysics( nextProps, newPosition );

            this.advancing = false;

        }

    }

    onPlayerContactEndTest( event ) {

        const otherBody = event.bodyA === this.playerBody ? event.bodyB : (
            event.bodyB === this.playerBody ? event.bodyA : null
        );

        if( otherBody ) {

            const { playerContact } = this.state;

            this.setState({
                playerContact: without( playerContact, otherBody.id )
            });

        }

    }

    onPlayerCollide( event ) {

        //console.log( 'collision detected' );

        const { contact } = event;
        const otherBody = contact.bi === this.playerBody ? contact.bj : contact.bi;
        const contactNormal = getCardinalityOfVector( new THREE.Vector3().copy(
            contact.bi === this.playerBody ?
                contact.ni :
                contact.ni.negate()
        ));

        const { playerContact } = this.state;

        const assign = {
            [ otherBody.id ]: contactNormal
        };
        this.setState({
            playerContact: Object.assign( {}, playerContact, assign )
        });

    }

    updatePhysics() {

        const {
            visibleEntities, playerScale, nextLevel, currentLevel, jumpForce,
            moveForce, airMoveForce
        } = this.props;
        const { playerContact } = this.state;
        const { keysDown } = this;
        let forceX = 0;
        let forceZ = 0;

        const isLeft = ( KeyCodes.A in keysDown ) || ( KeyCodes.LEFT in keysDown );
        const isRight = ( KeyCodes.D in keysDown ) || ( KeyCodes.RIGHT in keysDown );
        const isUp = ( KeyCodes.W in keysDown ) || ( KeyCodes.UP in keysDown );
        const isDown = ( KeyCodes.S in keysDown ) || ( KeyCodes.DOWN in keysDown );
        const playerPosition = new THREE.Vector3().copy( this.playerBody.position );
        const playerSnapped = new THREE.Vector3(
            snapTo( playerPosition.x, playerScale ),
            snapTo( playerPosition.y, playerScale ),
            snapTo( playerPosition.z, playerScale )
        ).addScalar( -playerScale / 2 );

        const contactKeys = Object.keys( playerContact );
        let tubeEntrances;

        if( nextLevel && playerScale === nextLevel.scale.x && !this.advancing && (
             ( playerPosition.x > ( nextLevel.position.x - 0.475 ) ) &&
             ( playerPosition.x < ( nextLevel.position.x + 0.475 ) ) &&
             ( playerPosition.z > ( nextLevel.position.z - 0.475 ) ) &&
             ( playerPosition.z < ( nextLevel.position.z + 0.475 ) )
        ) ) {
            this.advancing = true;
            this.props.advanceLevel( currentLevel.nextLevelId );
        }

        if( !this.state.tubeFlow ) {

            for( let i = 0; i < contactKeys.length; i++ ) {
                const key = contactKeys[ i ];

                const physicsBody = this.world.bodies.find( ( entity ) => {
                    return entity.id.toString() === key;
                });

                const { entity } = physicsBody;
                if( entity.type === 'tube' || entity.type === 'tubebend' ) {

                    tubeEntrances = getEntrancesForTube( entity, playerScale );
                    this.setState({
                        entrance1: tubeEntrances.entrance1,
                        entrance2: tubeEntrances.entrance2
                    });
                    break;

                }

            }
            
        }

        if( isLeft ) {
            forceX -= moveForce;
        }
        if( isRight ) {
            forceX += moveForce;
        }
        if( isUp ) {
            forceZ -= airMoveForce;
        }
        if( isDown ) {
            forceZ += airMoveForce;
        }

        let newTubeFlow;
        if( tubeEntrances ) {

            const { tube, entrance1, entrance2, threshold1, threshold2 } = tubeEntrances;
            const isAtEntrance1 = vec3Equals( playerSnapped, entrance1 );
            const isAtEntrance2 = vec3Equals( playerSnapped, entrance2 );
            const isInTubeRange = isAtEntrance1 || isAtEntrance2;
            const entrancePlayerStartsAt = isAtEntrance1 ? entrance1 : entrance2;
            const thresholdPlayerStartsAt = isAtEntrance1 ? threshold1 : threshold2;
            const thresholdPlayerEndsAt = isAtEntrance1 ? threshold2 : threshold1;

            const playerTowardTube = playerSnapped.clone().add(
                new THREE.Vector3( forceX, 0, forceZ )
                    .normalize()
                    .multiplyScalar( playerScale )
            );

            if( isInTubeRange && vec3Equals( playerTowardTube, tube.position ) ) {

                this.playerBody.removeEventListener( 'collide', this.onPlayerCollide );
                this.world.removeEventListener( 'endContact', this.onPlayerContactEndTest );

                const newPlayerContact = Object.keys( playerContact ).reduce( ( memo, key ) => {

                    const { entity } = this.world.bodies.find( ( search ) => {
                        return search.id.toString() === key;
                    });

                    if( entity.type !== 'tubebend' && entity.type !== 'tube' ) {
                        memo[ key ] = playerContact[ key ];
                    }

                    return memo;
                }, {} );

                newTubeFlow = [{
                    start: playerPosition.clone(),
                    end: thresholdPlayerStartsAt
                }, {
                    start: thresholdPlayerStartsAt,
                    end: thresholdPlayerEndsAt,
                    exit: isAtEntrance1 ? entrance2 : entrance1
                }];

                let nextTube;
                let currentTube = tube;
                let currentEntrance = entrancePlayerStartsAt;

                let failSafe = 0;
                while( failSafe < 30 && ( nextTube = findNextTube( currentTube, currentEntrance, visibleEntities, playerScale ) ) ) {

                    failSafe++;

                    //console.log('FOUND ANOTHER TUBE');

                    const isAtNextEntrance1 = vec3Equals( nextTube.entrance1, currentTube.position );
                    const isAtNextEntrance2 = vec3Equals( nextTube.entrance2, currentTube.position );

                    if( !isAtNextEntrance1 && !isAtNextEntrance2 ) {
                        console.warn('current entrance',currentEntrance,'did not match either',nextTube.entrance1,'or', nextTube.entrance2);
                        continue;
                    }

                    newTubeFlow.push({
                        start: isAtNextEntrance1 ? nextTube.threshold1 : nextTube.threshold2,
                        end: isAtNextEntrance1 ? nextTube.threshold2 : nextTube.threshold1,
                        exit: isAtNextEntrance1 ? nextTube.entrance2 : nextTube.entrance1
                    });

                    currentEntrance = currentTube.position;
                    currentTube = nextTube.tube;

                }

                if( failSafe > 29 ) {
                    newTubeFlow = null;
                }

                //console.log('traversing',newTubeFlow.length - 1,'tubes');

                this.setState({
                    playerContact: newPlayerContact,
                    playerSnapped,
                    startTime: Date.now(),
                    tubeFlow: newTubeFlow,
                    currentFlowPosition: newTubeFlow[ 0 ].start,
                    tubeIndex: 0
                });

            }

        }

        const isFlowing = this.state.tubeFlow || newTubeFlow;

        if( this.state.tubeFlow ) {

            const time = Date.now();
            let { startTime, tubeIndex } = this.state;
            const { tubeFlow } = this.state;

            const isLastTube = tubeIndex === tubeFlow.length - 1;

            let currentPercent = ( time - startTime ) / ( tubeIndex === 0 ?
                tubeStartTravelDurationMs : tubeTravelDurationMs
            ) * ( this.state.debug ? 0.1 : 1 );
            let isDone;

            if( currentPercent >= 1 ) {

                //console.log('at end of tube...');

                if( isLastTube ) {
                    //console.log('FREE');
                    const lastTube = tubeFlow[ tubeIndex ];

                    this.playerBody.addEventListener( 'collide', this.onPlayerCollide );
                    this.world.addEventListener( 'endContact', this.onPlayerContactEndTest );

                    isDone = true;
                    this.setState({
                        tubeFlow: null,
                        currentFlowPosition: null
                    });
                    resetBodyPhysics( this.playerBody, new CANNON.Vec3(
                        lastTube.exit.x,
                        lastTube.exit.y,
                        lastTube.exit.z
                    ) );
                } else {
                    //console.log('NEXT_TUBE');
                    tubeIndex++;
                    startTime = Date.now();
                    currentPercent = 0;
                }

            }

            const currentTube = tubeFlow[ tubeIndex ];

            if( !isDone ) {

                this.setState({
                    currentFlowPosition: lerp(
                        currentTube.start, isLastTube ?
                            currentTube.exit :
                            currentTube.end,
                        currentPercent
                    ),
                    tubeIndex,
                    startTime
                });

            }

        }

        if( !isFlowing ) {

            if( KeyCodes.SPACE in keysDown ) {

                const coolDownKeys = Object.keys( this.wallCoolDowns );

                const jumpableWalls = Object.keys( playerContact ).reduce( ( memo, key ) => {

                    if( coolDownKeys.indexOf( key ) > -1 ) {
                        return memo;
                    }

                    if( playerContact[ key ] === Cardinality.DOWN ) {
                        memo.down = true;
                    }

                    if( playerContact[ key ] === Cardinality.LEFT ) {
                        memo.left = true;
                    }

                    if( playerContact[ key ] === Cardinality.RIGHT ) {
                        memo.right = true;
                    }

                    return memo;
                }, {});

                const jumpScale = Math.min( playerScale * 2, 1 );

                if( Object.keys( jumpableWalls ).length ) {

                    if( jumpableWalls.down ) {

                        forceZ -= 5000;

                    } else if( jumpableWalls.right ) {

                        console.log('rightjump');
                        forceZ -= jumpForce * wallJumpVerticalDampen;
                        forceX -= jumpForce;

                    } else if( jumpableWalls.left ) {

                        console.log('leftjump');
                        forceZ -= jumpForce * wallJumpVerticalDampen;
                        forceX += jumpForce;

                    }

                    const coolDowns = {};
                    for( const key in playerContact ) {
                        coolDowns[ key ] = Date.now();
                    }
                    this.wallCoolDowns = Object.assign( {}, this.wallCoolDowns, coolDowns );

                    //this.playerBody.initVelocity.setZero();
                    //this.playerBody.force.setZero();
                    //this.playerBody.velocity.setZero();
                    this.playerBody.angularVelocity.setZero();
                    this.playerBody.initAngularVelocity.setZero();

                    const now = Date.now();
                    console.log('jumping', now - ( this.lastJump || 0 ) );
                    this.lastJump = now;

                }

            }

            this.playerBody.applyForce(
                new CANNON.Vec3( forceX, 0, forceZ ),
                new CANNON.Vec3( 0, 0, 0 )
            );
            
        }

        // Step the physics world
        const delta = clock.getDelta();
        if( delta ) {
            this.world.step( 1 / 60, delta, 3 );
        }

    }

    _getMeshStates( physicsBodies ) {

        return physicsBodies.map( ( body ) => {
            const { position, quaternion } = body;
            return {
                position: new THREE.Vector3().copy( position ),
                quaternion: new THREE.Quaternion().copy( quaternion )
            };
        });

    }

    _onAnimate() {

        const {
            visibleEntities, playerRadius, playerMass, playerScale, currentLevel
        } = this.props;
        const playerPosition = this.state.currentFlowPosition || this.playerBody.position;

        this.updatePhysics();

        const state = {
            time: Date.now(),
            meshStates: this._getMeshStates( this.physicsBodies ),
            lightPosition: new THREE.Vector3(
                radius * Math.sin( clock.getElapsedTime() * lightRotationSpeed ),
                10,
                radius * Math.cos( clock.getElapsedTime() * lightRotationSpeed )
            )
        };

        Object.keys( this.wallCoolDowns ).forEach( ( key ) => {

            if( this.wallCoolDowns[ key ] + coolDownTimeMs < Date.now() ) {
                delete this.wallCoolDowns[ key ];
            }

        });

        if( KeyCodes['`'] in this.keysDown ) {

            if( !this.debugSwitch ) {
                state.debug = !this.state.debug;
                this.debugSwitch = true;
            }

        } else {

            this.debugSwitch = false;

        }

        if( KeyCodes.ESC in this.keysDown ) {

            this.props.onGameEnd();

        }

        //let cameraDelta = 0;
        //if( KeyCodes.Z in this.keysDown ) {
            //cameraDelta = -0.1;
        //} else if( KeyCodes.X in this.keysDown ) {
            //cameraDelta = 0.1;
        //}

        //if( cameraDelta ) {

            //state.cameraPosition = new THREE.Vector3(
                //this.state.cameraPosition.x,
                //this.state.cameraPosition.y + cameraDelta,
                //this.state.cameraPosition.z
            //);

        //}

        state.cameraPosition = this.state.cameraPosition.clone().lerp( new THREE.Vector3(
            playerPosition.x,
            playerPosition.y + cameraMultiplierFromPlayer * getCameraDistanceToPlayer( cameraAspect, cameraFov, playerScale ),
            playerPosition.z
        ), 0.05 / playerScale );

        for( let i = 0; i < visibleEntities.length; i++ ) {

            const entity = visibleEntities[ i ];

            if( entity.type === 'shrink' || entity.type === 'grow' ) {

                if( entity.position.distanceTo( playerPosition ) < playerRadius ) {

                    const isShrinking = entity.type === 'shrink';
                    const multiplier = isShrinking ? 0.5 : 2;

                    this.world.remove( this.playerBody );

                    const playerBody = new CANNON.Body({
                        material: wallMaterial,
                        mass: playerMass
                    });
                    playerBody.addEventListener( 'collide', this.onPlayerCollide );

                    const playerShape = new CANNON.Sphere( playerRadius * multiplier );

                    playerBody.addShape( playerShape );
                    const newPosition = playerPosition;
                    playerBody.position.set(
                        newPosition.x,
                        newPosition.y + ( isShrinking ? 0 : playerRadius ),
                        newPosition.z - ( isShrinking ? 0 : playerRadius ),
                    );

                    this.world.addBody( playerBody );

                    this.playerBody = playerBody;
                    this.physicsBodies[ 0 ] = playerBody;

                    this.props.scalePlayer( currentLevel.id, entity.id, multiplier );

                }

            }

        }

        this.setState( state );

    }

    onKeyDown( event ) {

        const which = { [ event.which ]: true };

        if( event.which === KeyCodes.SPACE ||
                event.which === KeyCodes.UP ||
                event.which === KeyCodes.DOWN
            ) {
            event.preventDefault();
        }

        this.keysDown = Object.assign( {}, this.keysDown, which );

    }

    onKeyUp( event ) {

        this.keysDown = without( this.keysDown, event.which );

    }

    render() {

        const {
            meshStates, time, cameraPosition, currentFlowPosition, debug
        } = this.state;

        const {
            playerRadius, playerScale, visibleEntities, nextLevel,
            nextLevelEntities
        } = this.props;

        const playerPosition = new THREE.Vector3().copy(
            currentFlowPosition || this.playerBody.position
        );
        const lookAt = lookAtVector(
            cameraPosition,
            playerPosition
        );

        return <div>
            <React3
                mainCamera="camera"
                width={ gameWidth }
                height={ gameHeight }
                onAnimate={ this._onAnimate }
            >
                <scene
                    ref="scene"
                >

                    <perspectiveCamera
                        name="camera"
                        fov={ cameraFov }
                        aspect={ cameraAspect }
                        near={ 0.1 }
                        far={ 1000 }
                        position={ cameraPosition }
                        quaternion={ lookAt }
                        ref="camera"
                    />

                    <resources>
                        <boxGeometry
                            resourceId="1x1box"

                            width={1}
                            height={1}
                            depth={1}

                            widthSegments={1}
                            heightSegments={1}
                        />
                        <meshPhongMaterial
                            resourceId="playerMaterial"
                            color={ 0xFADE95 }
                        />
                        <meshPhongMaterial
                            resourceId="entranceMaterial"
                            color={ 0xff0000 }
                        />
                        <meshPhongMaterial
                            resourceId="exitMaterial"
                            color={ 0x0000ff }
                        />

                        <sphereGeometry
                            resourceId="sphereGeometry"
                            radius={ 0.5 }
                            widthSegments={ 6 }
                            heightSegments={ 6 }
                        />

                        <planeBufferGeometry
                            resourceId="planeGeometry"
                            width={1}
                            height={1}
                            widthSegments={1}
                            heightSegments={1}
                        />

                        <shape resourceId="tubeWall">
                            <absArc
                                x={0}
                                y={0}
                                radius={0.5}
                                startAngle={0}
                                endAngle={Math.PI * 2}
                                clockwise={false}
                            />
                            <hole>
                                <absArc
                                    x={0}
                                    y={0}
                                    radius={0.4}
                                    startAngle={0}
                                    endAngle={Math.PI * 2}
                                    clockwise
                                />
                            </hole>
                        </shape>

                        <meshPhongMaterial
                            resourceId="tubeMaterial"
                            color={0xffffff}
                            side={ THREE.DoubleSide }
                            transparent
                        >
                            <texture
                                url={ require( '../Game/tube-pattern-1.png' ) }
                                wrapS={ THREE.RepeatWrapping }
                                wrapT={ THREE.RepeatWrapping }
                                anisotropy={16}
                            />
                        </meshPhongMaterial>

                        <meshPhongMaterial
                            resourceId="shrinkWrapMaterial"
                            color={ 0x462B2B }
                            opacity={ 0.3 }
                            transparent
                        />

                        <meshPhongMaterial
                            resourceId="shrinkMaterial"
                            color={0xffffff}
                            side={ THREE.DoubleSide }
                            transparent
                        >
                            <texture
                                url={ require( '../Game/spiral-texture.png' ) }
                                wrapS={ THREE.RepeatWrapping }
                                wrapT={ THREE.RepeatWrapping }
                                anisotropy={16}
                            />
                        </meshPhongMaterial>

                        <meshPhongMaterial
                            resourceId="growWrapMaterial"
                            color={ 0x462B2B }
                            opacity={ 0.3 }
                            transparent
                        />

                        <meshPhongMaterial
                            resourceId="growMaterial"
                            color={0xffffff}
                            side={ THREE.DoubleSide }
                            transparent
                        >
                            <texture
                                url={ require( '../Game/grow-texture.png' ) }
                                wrapS={ THREE.RepeatWrapping }
                                wrapT={ THREE.RepeatWrapping }
                                anisotropy={16}
                            />
                        </meshPhongMaterial>

                        <sphereGeometry
                            resourceId="playerGeometry"
                            radius={ 1 }
                            widthSegments={ 20 }
                            heightSegments={ 20 }
                        />

                    </resources>

                    <ambientLight
                        color={ 0x777777 }
                    />

                    <directionalLight
                        color={ 0xffffff }
                        intensity={ 1.0 }

                        castShadow

                        shadowMapWidth={1024}
                        shadowMapHeight={1024}

                        shadowCameraLeft={-shadowD}
                        shadowCameraRight={shadowD}
                        shadowCameraTop={shadowD}
                        shadowCameraBottom={-shadowD}

                        shadowCameraFar={3 * shadowD}
                        shadowCameraNear={shadowD}
                        shadowDarkness={0.5}

                        position={this.state.lightPosition}
                    />

                    <Player
                        ref="player"
                        position={ playerPosition }
                        radius={ playerRadius }
                        quaternion={ new THREE.Quaternion().copy( this.playerBody.quaternion ) }
                        materialId="playerMaterial"
                    />

                    { debug && this.state.tubeFlow && <mesh
                        position={ this.state.tubeFlow[ this.state.tubeIndex ].start }
                        scale={ new THREE.Vector3( 0.5, 2, 0.5 )}
                    >
                        <geometryResource
                            resourceId="playerGeometry"
                        />
                        <materialResource
                            resourceId="entranceMaterial"
                        />
                    </mesh> }
                    { debug && this.state.tubeFlow && <mesh
                        position={ this.state.tubeIndex === this.state.tubeFlow.length - 1 ?
                            this.state.tubeFlow[ this.state.tubeIndex ].exit :
                            this.state.tubeFlow[ this.state.tubeIndex ].end
                        }
                        scale={ new THREE.Vector3( 2, 0.5, 2 )}
                    >
                        <geometryResource
                            resourceId="playerGeometry"
                        />
                        <materialResource
                            resourceId="exitMaterial"
                        />
                    </mesh> }

                    { debug && this.state.entrance1 && <mesh
                        position={ this.state.entrance1 }
                        scale={ new THREE.Vector3( 0.5, 2, 0.5 )}
                    >
                        <geometryResource
                            resourceId="playerGeometry"
                        />
                        <materialResource
                            resourceId="playerMaterial"
                        />
                    </mesh> }
                    { debug && this.state.entrance2 && <mesh
                        position={ this.state.entrance2 }
                        scale={ new THREE.Vector3( 0.5, 2, 0.5 )}
                    >
                        <geometryResource
                            resourceId="playerGeometry"
                        />
                        <materialResource
                            resourceId="exitMaterial"
                        />
                    </mesh> }
                    { debug && this.state.playerSnapped && <mesh
                        position={this.state.playerSnapped }
                        scale={ new THREE.Vector3( 0.1, 3.5, 0.1 )}
                    >
                        <geometryResource
                            resourceId="playerGeometry"
                        />
                        <materialResource
                            resourceId="exitMaterial"
                        />
                    </mesh> }

                    <StaticEntities
                        ref="staticEntities"
                        entities={ visibleEntities }
                        time={ time }
                    />
                    
                    { nextLevel && <StaticEntities
                        position={ nextLevel.position }
                        scale={ nextLevel.scale }
                        ref="nextLevel"
                        entities={ nextLevelEntities }
                        time={ time }
                    /> }

                    { debug && Object.keys( this.state.playerContact || {} ).map( ( key ) => {

                        return <mesh
                            position={ playerPosition.clone().add( this.state.playerContact[ key ] ) }
                            scale={ new THREE.Vector3( 0.5, 7, 0.5 )}
                            key={ key }
                        >
                            <geometryResource
                                resourceId="playerGeometry"
                            />
                            <materialResource
                                resourceId="playerMaterial"
                            />
                        </mesh>;

                    }) }

                    { debug && [1,2,3,4].map( ( i ) => {

                        let e;
                        switch(i) {
                            case 1:
                                e = new THREE.Quaternion( 0, 0, 0, 1 )
                                    .clone()
                                    .multiply( new THREE.Quaternion()
                                        .setFromEuler( new THREE.Euler(
                                            THREE.Math.degToRad( 90 ),
                                            THREE.Math.degToRad( 0 ),
                                            0
                                        ) )
                                    );
                                break;
                            case 2:
                                e = new THREE.Quaternion( 0, 0, 0, 1 )
                                    .clone()
                                    .multiply( new THREE.Quaternion()
                                        .setFromEuler( new THREE.Euler(
                                            THREE.Math.degToRad( 0 ),
                                            THREE.Math.degToRad( -90 ),
                                            0
                                        ) )
                                    );
                                break;
                            case 3:
                                e = new THREE.Quaternion( 0, 0, 0, 1 )
                                    .clone()
                                    .multiply( new THREE.Quaternion()
                                        .setFromEuler( new THREE.Euler(
                                            THREE.Math.degToRad( -90 ),
                                            THREE.Math.degToRad( 90 ),
                                            0
                                        ) )
                                    );
                                break;
                            case 4:
                                e = new THREE.Quaternion( 0, 0, 0, 1 )
                                    .clone()
                                    .multiply( new THREE.Quaternion()
                                        .setFromEuler( new THREE.Euler(
                                            THREE.Math.degToRad( 180 ),
                                            THREE.Math.degToRad( -90 ),
                                            0
                                        ) )
                                    );
                                break;
                            default:
                                console.log('gfy');
                        }

                        const position = new THREE.Vector3( ( i * 3 ) - 7, 3, 0 );

                        const { entrance1, entrance2 } = getEntrancesForTube({
                            position, rotation: e, type: 'tubebend'
                        }, playerScale );

                        return <group key={i}>

                            <mesh
                                position={ entrance1 }
                                scale={ new THREE.Vector3( 0.5, 2, 0.5 )}
                            >
                                <geometryResource
                                    resourceId="playerGeometry"
                                />
                                <materialResource
                                    resourceId="playerMaterial"
                                />
                            </mesh>
                            <mesh
                                position={ entrance2 }
                                scale={ new THREE.Vector3( 0.5, 2, 0.5 )}
                            >
                                <geometryResource
                                    resourceId="playerGeometry"
                                />
                                <materialResource
                                    resourceId="exitMaterial"
                                />
                            </mesh>

                            <TubeBend
                                key={ i }
                                position={ position }
                                rotation={ e }
                                scale={ new THREE.Vector3(1,1,1)}
                                materialId="tubeMaterial"
                            />

                        </group>;

                    } ) }

                </scene>
            </React3>

            <input value={ this.playerBody.velocity.y } />
        </div>;
    }

}
