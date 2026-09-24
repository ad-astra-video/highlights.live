"""Pitch homography -> ground-plane ball velocity (INC-2b / ADAAAA-4326).

Slice 3 of the ball-centric candidate signal. The ball track (``ball_track.py``)
gives a per-frame ball box in *image* space. A broadcast camera sees the pitch
under perspective, so raw image displacement does not equal on-pitch distance:
a ball moving near the bottom of the frame spans far fewer meters per pixel than
the same motion near the top. Converting that displacement to real ground-plane
m/s requires a pitch homography.

This module:

  - estimates an image -> field homography H (a 3x3 projective matrix) from a
    set of >4 corresponding points between image space (pixels or normalized)
    and real field coords (meters), using the normalized DLT. The reference
    points come from pitch lines / the goal frame (a rectangle on the pitch),
    provided by the caller or the calibration fixture -- see
    ``homography_from_pitch_rect``.
  - projects a ball box center from image to field coords via H.
  - converts consecutive mapped ball positions + frame timestamps into
    ground-plane m/s velocity (vxMps, vyMps, speedMps) matching the
    ``packages/events`` BallVelocity contract, with a small smoothing window to
    keep single-frame jitter (and the ball being tiny) from poisoning the speed.

It is pure numpy/SVD -- no cv2 -- so it runs in the offline test env and in
perceive without new dependencies.

Coordinate conventions (must be the same everywhere this module is used):

  - Image points are (u, v). Either raw pixels or normalized [0,1] coords work
    as long as the SAME space is used to fit H and to project (see
    ``PitchHomography``). ``ball_track.BBox`` exposes normalized boxes, so the
    pipeline multiplies by frame W/H (or passes normalized points throughout).
  - Field points are (X, Y) in meters, ground plane, origin/axes per the
    calibration used (pitch center or a corner, typically +X = width across the
    pitch, +Y = length down the pitch). ``posXm``/``posYm`` and vx/vy are
    expressed in the same axes.

Acceptance: ground-plane speed error <= 15% vs hand-labeled reference points,
verified in ``tests/test_pitch_homography.py`` against a synthetic camera that
moves the ball at a known on-pitch speed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np

# Image point (u, v) -- pixels or normalized [0,1], consistent per instance.
ImagePoint = Tuple[float, float]
# Field point (X, Y) in meters, ground plane.
FieldPoint = Tuple[float, float]

_MIN_POINTS = 4  # DLT needs >= 4 correspondences


# ---------------------------------------------------------------------------
# Homography estimation (normalized DLT)
# ---------------------------------------------------------------------------
def normalize_points(pts: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Normalize 2D points to ~zero-mean, unit std for numerical stability.

    Returns the normalized (N,2) points and the 3x3 similarity transform T such
    that ``norm_pts = T @ hom(pts)`` (homogeneous). Inverting T maps back.
    """
    pts = np.asarray(pts, dtype=float)
    if pts.ndim != 2 or pts.shape[1] != 2:
        raise ValueError("points must be shape (N, 2)")
    if len(pts) < 2:
        raise ValueError("need at least 2 points to normalize")
    centroid = pts.mean(axis=0)
    dists = np.linalg.norm(pts - centroid, axis=1)
    scale = np.sqrt(2.0) / (dists.mean() + 1e-12)
    T = np.array(
        [
            [scale, 0.0, -scale * centroid[0]],
            [0.0, scale, -scale * centroid[1]],
            [0.0, 0.0, 1.0],
        ]
    )
    norm = (pts - centroid) * scale
    return norm, T


def hom_to_cart(h: np.ndarray) -> np.ndarray:
    """Normalize an (N,3) homogeneous row set to cartesian (N,2) by w-division."""
    h = np.asarray(h, dtype=float)
    w = h[:, 2:3]
    w = np.where(np.abs(w) < 1e-12, 1e-12, w)
    return h[:, :2] / w


def estimate_homography(
    image_pts: Sequence[ImagePoint], field_pts: Sequence[FieldPoint]
) -> np.ndarray:
    """Estimate the image->field homography H (3x3) via normalized DLT.

    ``H @ [u, v, 1]^T ~ [X, Y, 1]^T`` (projective, up to scale). Requires at
    least 4 correspondences; more points make it a least-squares estimate.
    """
    img = np.asarray(image_pts, dtype=float)
    fld = np.asarray(field_pts, dtype=float)
    if img.shape != fld.shape or img.shape[1] != 2:
        raise ValueError("image_pts and field_pts must be equal (N,2) arrays")
    n = len(img)
    if n < _MIN_POINTS:
        raise ValueError(f"need >= {_MIN_POINTS} correspondences, got {n}")

    # Normalize both spaces so the DLT solve is numerically stable.
    norm_img, Timg = normalize_points(img)
    norm_fld, Tfld = normalize_points(fld)

    A = np.zeros((2 * n, 9))
    xi, yi = norm_img[:, 0], norm_img[:, 1]
    xw, yw = norm_fld[:, 0], norm_fld[:, 1]
    z = 1.0
    for i in range(n):
        A[2 * i] = [-xi[i], -yi[i], -z, 0, 0, 0, xw[i] * xi[i], xw[i] * yi[i], xw[i]]
        A[2 * i + 1] = [0, 0, 0, -xi[i], -yi[i], -z, yw[i] * xi[i], yw[i] * yi[i], yw[i]]

    _, _, vh = np.linalg.svd(A)
    h = vh[-1]  # unit singular vector for the smallest singular value
    Hn = h.reshape(3, 3)

    # Denormalize: H = Tfld^-1 @ Hn @ Timg
    H = np.linalg.inv(Tfld) @ Hn @ Timg
    # Fix scale so H[2,2] == 1 for a stable canonical form.
    H = H / (H[2, 2] + 1e-12)
    return H


def homography_from_pitch_rect(
    image_corners: Sequence[ImagePoint], field_rect: Sequence[FieldPoint]
) -> np.ndarray:
    """Fit the image->field homography from a pitch rectangle reference.

    ``image_corners`` are the image-space corners of the pitch rectangle (or of
    the goal frame) in the same corner ORDER as ``field_rect``'s corresponding
    field points (e.g. 4 corners of the pitch, or the 4 goal-post corners).

    This is the primary calibration path for the "pitch line / goal-frame
    reference" in the scope: the 4 corners give a minimal homography; passing
    more image reference points (e.g. line intersections) improves accuracy.
    """
    return estimate_homography(list(image_corners), list(field_rect))


def project_points(H: np.ndarray, image_pts: Sequence[ImagePoint]) -> np.ndarray:
    """Apply H to image points -> field points (N,2) in meters."""
    H = np.asarray(H, dtype=float)
    img = np.asarray(image_pts, dtype=float)
    if img.ndim == 1:
        img = img[None, :]
    ones = np.ones((len(img), 1))
    hom = np.hstack([img, ones])  # (N,3)
    proj = hom @ H.T  # (N,3)
    return hom_to_cart(proj)


def project_ball_center(
    H: np.ndarray, bbox: Sequence[float]
) -> FieldPoint:
    """Map a ball box's center to field coords (meters) via H.

    bbox must be in the same image space H was fit with (pixels or normalized).
    """
    if len(bbox) != 4:
        raise ValueError("bbox must be (x1, y1, x2, y2)")
    x1, y1, x2, y2 = (float(v) for v in bbox)
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    out = project_points(H, [(cx, cy)])
    return (float(out[0, 0]), float(out[0, 1]))


# ---------------------------------------------------------------------------
# Ball velocity estimation (ground-plane m/s)
# ---------------------------------------------------------------------------
@dataclass
class BallVelocity:
    """Ground-plane ball velocity in m/s (mirrors packages/events BallVelocity).

    ``vxMps``/``vyMps`` are the on-pitch velocity components, ``speedMps`` the
    scalar magnitude. All in field meters / second. ``posXm``/``posYm`` is the
    ball's current field position. ``homography`` True means the speed came from
    the pitch homography (always true for this module).
    """

    vxMps: float
    vyMps: float
    speedMps: float
    posXm: Optional[float] = None
    posYm: Optional[float] = None
    homography: bool = True


class BallVelocityEstimator:
    """Convert per-frame ball boxes + timestamps to ground-plane m/s.

    Maintains a small ring of recent on-pitch (X, Y, t) samples and estimates
    velocity by a least-squares line fit over the LAST ``window`` samples. A
    least-squares fit over a small window is more stable than a bare two-point
    difference for a tiny, jittery ball box while still tracking a changing
    speed (short window). The constant-speed acceptance test passes for both.

    Uses the provided homography H (image -> field). If H is None, returns
    ``homography=False`` image-space estimates (fallback), never crashing.
    """

    def __init__(self, H: Optional[np.ndarray] = None, window: int = 4):
        if H is not None:
            Hmat = np.asarray(H, dtype=float)
            if Hmat.shape != (3, 3):
                raise ValueError("H must be a 3x3 matrix")
            H = Hmat
        self.H = H
        self.window = max(2, int(window))
        # (X, Y, t) on-pitch samples.
        self._samples: List[Tuple[float, float, float]] = []

    def reset(self) -> None:
        self._samples = []

    def update(
        self, bbox: Sequence[float], ts: float
    ) -> Optional[BallVelocity]:
        """Push one ball box (+ timestamp) and return the velocity estimate.

        ``bbox`` in image space matching H (normalized or pixels, see module
        docstring). Returns None until enough samples exist or the ball box is
        degenerate (zero area).
        """
        x1, y1, x2, y2 = (float(v) for v in bbox)
        if (x2 - x1) <= 0 or (y2 - y1) <= 0:
            return None
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0

        if self.H is not None:
            fx, fy = project_ball_center(self.H, bbox)
            pos = (fx, fy)
        else:
            # No calibration: image-space fallback (units are px, not m).
            pos = (cx, cy)

        self._samples.append((pos[0], pos[1], float(ts)))
        if len(self._samples) > self.window:
            self._samples.pop(0)
        return self.estimate()

    def estimate(
        self, position: Optional[FieldPoint] = None
    ) -> Optional[BallVelocity]:
        """Return velocity from the current sample window.

        ``position`` optionally overrides the current position reported.
        """
        if len(self._samples) < 2:
            return None
        arr = np.array(self._samples, dtype=float)  # (N,3): X, Y, t
        t0 = arr[0, 2]
        dt = arr[-1, 2] - t0
        if dt <= 1e-6:
            return None
        x, y = arr[:, 0], arr[:, 1]
        # Shift time so the intercept is at t0; slope = units/second.
        tt = arr[:, 2] - t0
        vx = float(np.polyfit(tt, x, 1)[0])
        vy = float(np.polyfit(tt, y, 1)[0])
        speed = float(np.hypot(vx, vy))
        if position is None:
            position = (float(x[-1]), float(y[-1]))
        return BallVelocity(
            vxMps=vx,
            vyMps=vy,
            speedMps=speed,
            posXm=position[0],
            posYm=position[1],
            homography=self.H is not None,
        )
