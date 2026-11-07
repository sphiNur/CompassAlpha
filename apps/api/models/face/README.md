# Face models (attendance face check, 2026-11-05)

Run on the API server with onnxruntime-web (WebAssembly, CPU); nothing is
sent to a third party.

| File                                       | Model                                                            | Source                                                                                                                                                                                                                           | License              |
| ------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `face_detection_yunet_2023mar.onnx`        | YuNet face detector (box + 5 landmarks)                          | [opencv_zoo/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)                                                                                                             | MIT, © 2020 Shiqi Yu |
| `face_recognition_sface_2021dec_int8.onnx` | SFace recognizer, int8 (128-d feature)                           | [opencv_zoo/models/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)                                                                                                         | Apache-2.0           |
| `MiniFASNetV2.onnx`                        | Silent-Face anti-spoofing, crop scale 2.7 (liveness, 2026-11-06) | ONNX export of [minivision-ai/Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing) weights from [yakhyo/face-anti-spoofing](https://github.com/yakhyo/face-anti-spoofing/releases/tag/weights) | Apache-2.0           |
| `MiniFASNetV1SE.onnx`                      | Same, crop scale 4.0                                             | same                                                                                                                                                                                                                             | Apache-2.0           |

SHA-256:

```
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  face_detection_yunet_2023mar.onnx
2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a  face_recognition_sface_2021dec_int8.onnx
b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907  MiniFASNetV2.onnx
ebab7f90c7833fbccd46d3a555410e78d969db5438e169b6524be444862b3676  MiniFASNetV1SE.onnx
```

Same person / different person: cosine of the two features, threshold
0.363 (OpenCV's documented value for SFace). Checked locally on public-domain
portraits: two photos of one person 0.81, different people 0.16–0.29.

Liveness (2026-11-06): the two MiniFASNet models' real-face probability,
averaged; input is the face box widened by the crop scale, 80×80, BGR
0–255 (as Silent-Face). Checked locally: the Silent-Face sample photo of a
real face 1.00, its printed-photo and screen samples 0.03 and 0.01;
public-domain portraits 0.60–1.00. Head turn comes from YuNet's landmarks
(`yawOf` in pipeline.ts). The phone's live prompts use MediaPipe's
BlazeFace short-range detector (Apache-2.0,
`apps/web/src/assets/mediapipe/blaze_face_short_range.tflite`, sha256
b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f).
The face enrollment ring (2026-11-07) uses MediaPipe's Face Landmarker
instead (Apache-2.0, float16 v1,
`apps/web/src/assets/mediapipe/face_landmarker.task`, sha256
64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff): 478
stable points every frame, so the ring follows the head smoothly. The
head turn and tilt are measured from its eye, nose and mouth points the
same way as on the server.
