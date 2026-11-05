# Face models (attendance face check, 2026-11-05)

Run on the API server with onnxruntime-web (WebAssembly, CPU); nothing is
sent to a third party.

| File | Model | Source | License |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet face detector (box + 5 landmarks) | [opencv_zoo/models/face_detection_yunet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT, © 2020 Shiqi Yu |
| `face_recognition_sface_2021dec_int8.onnx` | SFace recognizer, int8 (128-d feature) | [opencv_zoo/models/face_recognition_sface](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | Apache-2.0 |

SHA-256:

```
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  face_detection_yunet_2023mar.onnx
2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a  face_recognition_sface_2021dec_int8.onnx
```

Same person / different person: cosine of the two features, threshold
0.363 (OpenCV's documented value for SFace). Checked locally on public-domain
portraits: two photos of one person 0.81, different people 0.16–0.29.
