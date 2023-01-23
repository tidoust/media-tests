(module
  ;; Import console.log for debugging
  (import "console" "log" (func $log (param i32)))


  ;; Import memory buffer from JavaScript code
  ;; Buffer will contain the video frame to process and the result of the
  ;; processing (the "processFrame" method updates the buffer in place)
  (memory (import "js" "mem") 1)


  ;; The processFrame method loops over pixels in the video frame and replaces
  ;; green pixels by pixels from a static image
  (func (export "processFrame")
    ;; Function takes frame's width and height as parameters, and a number that
    ;; represents the pixel format in the VideoPixelFormat enum (first is 0):
    ;; https://w3c.github.io/webcodecs/#enumdef-videopixelformat
    (param $width i32)
    (param $height i32)
    (param $format i32)

    ;; Current pixel position and number of pixels to check
    (local $col i32)
    (local $row i32)
    (local $pos i32)
    (local $nbPixels i32)

    ;; Pixel color components
    (local $color i32)
    (local $r i32)
    (local $g i32)
    (local $b i32)
    (local $w3cBlue i32)

    ;; The VideoPixelFormat enum mapped to numbers
    ;; (same mapping table exists in JS code)
    ;; TODO: Code assumes an RGB-like format. Adjust code to deal with YUV!
    (local $I420 i32)
    (local $I420A i32)
    (local $I422 i32)
    (local $I444 i32)
    (local $NV12 i32)
    (local $RGBA i32)
    (local $RGBX i32)
    (local $BGRA i32)
    (local $BGRX i32)
    (local.set $I420 (i32.const 0))
    (local.set $I420A (i32.const 1))
    (local.set $I422 (i32.const 2))
    (local.set $I444 (i32.const 3))
    (local.set $NV12 (i32.const 4))
    (local.set $RGBA (i32.const 5))
    (local.set $RGBX (i32.const 6))
    (local.set $BGRA (i32.const 7))
    (local.set $BGRX (i32.const 8))

    ;; Loop on all pixels
    (local.set $col (i32.const 0))
    (local.set $row (i32.const 0))
    (local.set $pos (i32.const 0))

    ;; Compute number of pixels in the frame
    (local.set $nbPixels (i32.mul (local.get $width) (local.get $height)))

    ;; Compute value of W3C blue color as a 32-bit integer
    ;; W3C blue is #005a9c or rgba(0, 90, 156, 255), which is going to be stored
    ;; in little endian order.
    (if (i32.ge_u (local.get $format) (local.get $BGRA))
      ;; BGRA format:
      ;; 255 * 2^24 + 90 * 2^8 + 156 = 4 278 213 276
      (then (local.set $w3cBlue (i32.const 4278213276)))

      ;; RGBA format:
      ;; 255 * 2^24 + 156 * 2^16 + 90 * 2^8 = 4 288 436 736
      (else (local.set $w3cBlue (i32.const 4288436736)))
    )

    (block
      (loop $checkPixel
        ;; Each pixel is 4 bytes, each byte being one of the components. Beware
        ;; though, WebAssembly uses little-endian when it reads data from memory
        ;; whereas, assuming format is RGBA, bytes were copied in RGBA order. In
        ;; still assuming format is RGBA, reading the 4 color components at once
        ;; with a "load" instruction actually yields an integer in ABGR order.
        ;; Also note that memory offsets are always in bytes.
        (local.set $color (i32.load (i32.mul (local.get $pos) (i32.const 4))))

        (local.set $g (i32.and
          (i32.shr_u (local.get $color) (i32.const 8))
          (i32.const 255)))

        ;; Note format may be RGBA or BGRA. We're going to treat the red and
        ;; blue components in a symmetric way, so no need to distinguish between
        ;; them (just note that $r may mean "blue" and $b may mean "red")
        (local.set $b (i32.and
          (i32.shr_u (local.get $color) (i32.const 16))
          (i32.const 255)))
        (local.set $r (i32.and
          (local.get $color)
          (i32.const 255)))

        ;; Replace pixel if color is greenish enough
        (if (i32.gt_u (local.get $g) (i32.const 128))
          (then
            (if (i32.gt_u (local.get $g) (local.get $r))
              (then
                (if (i32.gt_u (local.get $g) (local.get $b))
                  (then
                    (i32.add (local.get $r) (local.get $b))
                    (i32.mul (i32.const 8))
                    (if (i32.lt_u (i32.mul (local.get $g) (i32.const 10)))
                      (then
                        ;; Did I mention that memory offsets are always in bytes already?
                        (i32.store
                          (i32.mul (local.get $pos) (i32.const 4))
                          (local.get $w3cBlue)
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )

        ;; Check next pixel unless we reached the end already
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (if (i32.lt_u (local.get $pos) (local.get $nbPixels))
          (then
            (br $checkPixel)
          )
        )
      )
    )
  )
)