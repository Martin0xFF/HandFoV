# WebXR Hand Tracking FOV & Subtended Angle Visualizer

A WebXR application to showcase and analyze the Field of View (FOV) and vertical subtended angle of hand tracking relative to the user's view (gaze) direction.

## Features

- **Vertical Angle Measurement**: Computes the exact vertical angle from the user's view direction down to the hand's palm in realtime.
- **Virtual Mirror (`Reflector`)**: Reflects the user's hands, tracking skeleton, visual indicators, and environment in front of the user.
- **HUD Readout on Mirror**: An integrated dashboard directly mounted on the mirror frame displaying active hand angles, pitch elevation, and distance.
- **3D Angle Visualizer**:
  - Gaze ray projecting from the headset forward.
  - Palm vector connecting the head origin to the hand palm.
  - Slerp-based angular arc measuring the angular separation.
  - Floating 3D billboard with the angle value near the hand.
- **Desktop Simulator**: When running in standard desktop browsers without a headset, provides interactive mouse/keyboard controls to simulate head orientation and hand movement.
- **HTTPS Dev Server**: Self-signed SSL server required for WebXR secure context.

## Desktop Controls
- Click + Drag: Rotate head view direction (gaze).
- Space + Click + Drag: Move simulated hand in 3D space.
- Space + Mouse Wheel: Move simulated hand closer / further away.
